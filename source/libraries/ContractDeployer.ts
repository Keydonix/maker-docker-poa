import { readFile, writeFile } from "async-file";
import { encodeParams } from 'ethjs-abi';
import { stringTo32ByteHex, ETHER } from "./HelperFunctions";
import { CompilerOutput } from "solc";
import { Abi, AbiEvent, AbiFunction } from 'ethereum';
import { DeployerConfiguration } from './DeployerConfiguration';
import { Connector } from './Connector';
import { NetworkConfiguration } from './NetworkConfiguration';
import { AccountManager } from './AccountManager';
import { Contracts, Contract } from './Contracts';
import {
    GemFab,
    TubFab,
    VoxFab,
    DaiFab,
    DadFab,
    MomFab,
    TopFab,
    TapFab,
    WETH9,
    DSToken,
    DSRoles,
    DSValue,
    MatchingMarket,
    GemPit
} from "./ContractInterfaces";
import BN = require("bn.js");

type ContractAddressMapping = { [name: string]: string };

export class ContractDeployer {
    private readonly accountManager: AccountManager;
    private readonly configuration: DeployerConfiguration;
    private readonly connector: Connector;
    private readonly contracts: Contracts;

    private readonly defaultEthPriceInUsd   = "0x0000000000000000000000000000000000000000000000200000000000000000";
    private readonly defaultMakerPriceInUsd = "0x00000000000000000000000000000000000000000000002a0000000000000000";

    public static deployToNetwork = async (networkConfiguration: NetworkConfiguration, deployerConfiguration: DeployerConfiguration) => {
        const connector = new Connector(networkConfiguration);
        const accountManager = new AccountManager(connector, networkConfiguration.privateKey);

        const compilerOutput = JSON.parse(await readFile(deployerConfiguration.contractInputPath, "utf8"));
        const contractDeployer = new ContractDeployer(deployerConfiguration, connector, accountManager, compilerOutput);

        console.log(`\n\n-----------------
Deploying to: ${networkConfiguration.networkName}
    compiled contracts: ${deployerConfiguration.contractInputPath}
    contract address: ${deployerConfiguration.contractAddressesOutputPathJson}
    contract address env: ${deployerConfiguration.contractAddressesOutputPathEnvFile}
    upload blocks #s: ${deployerConfiguration.uploadBlockNumbersOutputPath}
`);
        await contractDeployer.deploy();
    };

    public constructor(configuration: DeployerConfiguration, connector: Connector, accountManager: AccountManager, compilerOutput: CompilerOutput) {
        this.configuration = configuration;
        this.connector = connector;
        this.accountManager = accountManager;
        this.contracts = new Contracts(compilerOutput);
    }

    public async deploy(): Promise<void> {
        const {saiGemContract, saiGovContract} = await this.deployTokens();
        const {saiPipContract, saiPepContract} = await this.deployFeeds();
        const {saiAdmContract, saiPitContract} = await this.deployAuthAndBurner();

        const daiFabContract = await this.deployDaiFab();

        // seth send $DAI_FAB 'makeTokens()
        console.log("DaiFab.makeTokens()");
        await daiFabContract.makeTokens();

        // seth send $DAI_FAB 'makeVoxTub(address,address,address,address,address)' $SAI_GEM $SAI_GOV $SAI_PIP $SAI_PEP $SAI_PIT
        console.log("DaiFab.makeVoxTub()");
        await daiFabContract.makeVoxTub(
            saiGemContract.address,
            saiGovContract.address,
            saiPipContract.address,
            saiPepContract.address,
            saiPitContract.address,
        );
        await this.deployConfigureDaiFab(daiFabContract, saiAdmContract);
        const odContract = await this.deployOasisdex(saiGemContract.address, await daiFabContract.sai_());

        await saiGemContract.deposit({attachedEth: new BN(40).mul(ETHER)})

        console.log({
            gem: saiGemContract.address,
            gov: saiGovContract.address,
            pip: saiPipContract.address,
            pep: saiPepContract.address,
            pit: saiPitContract.address,
            adm: saiGemContract.address,

            sai: await daiFabContract.sai_(),
            sin: await daiFabContract.sin_(),
            skr: await daiFabContract.skr_(),
            dad: await daiFabContract.dad_(),
            mom: await daiFabContract.mom_(),
            vox: await daiFabContract.vox_(),
            tub: await daiFabContract.tub_(),
            tap: await daiFabContract.tap_(),
            top: await daiFabContract.top_(),

            oasisDex: odContract.address,
        });
        const deployedContractAddresses = {
            tub: await daiFabContract.tub_(),
            oasisDex: odContract.address,
        };
        await this.generateAddressMappingFile(deployedContractAddresses);
    }

    private async deployOasisdex(gemAddress: string, daiAddress: string) {
        const odContract = new MatchingMarket(this.connector, this.accountManager, await this.simpleDeploy("MatchingMarket"), this.connector.gasPrice)
        await odContract.addTokenPairWhitelist(gemAddress, daiAddress);
        return odContract;
    }

    private async deployConfigureDaiFab(daiFabContract: DaiFab, saiAdmContract: DSRoles) {
        // seth send $DAI_FAB 'makeTapTop()'
        console.log("DaiFab.makeTapTop()");
        await daiFabContract.makeTapTop();

        // seth send $DAI_FAB 'configParams()'
        console.log("DaiFab.configParams()");
        await daiFabContract.configParams();

        console.log("DaiFab.verifyParams()");
        // seth send $DAI_FAB 'verifyParams()'
        await daiFabContract.verifyParams();

        // seth send $DAI_FAB 'configAuth(address)' $SAI_ADM
        console.log("DaiFab.configAuth()");
        await daiFabContract.configAuth(saiAdmContract.address);
    }

    private async deployAuthAndBurner() {
        // if [ -z $SAI_ADM ]
        // then
        //     SAI_ADM=$(dapp create DSRoles)
        //     seth send $SAI_ADM 'setRootUser(address,bool)' $ETH_FROM true
        // fi
        const saiAdmContract = new DSRoles(this.connector, this.accountManager, await this.simpleDeploy("DSRoles"), this.connector.gasPrice)
        await saiAdmContract.setRootUser(this.accountManager.defaultAddress, true);

        // test -z $SAI_PIT && SAI_PIT="0x0000000000000000000000000000000000000123"
        const saiPitContract = new GemPit(this.connector, this.accountManager, await this.simpleDeploy("GemPit"), this.connector.gasPrice);
        return {saiAdmContract, saiPitContract};
    }

    private async deployFeeds() {
        // test -z $SAI_PIP && PIPtx=$(dapp create DSValue)
        const saiPipContract = new DSValue(this.connector, this.accountManager, await this.simpleDeploy("DSValue"), this.connector.gasPrice)
        saiPipContract.poke( this.defaultEthPriceInUsd )
        // test -z $SAI_PEP && PEPtx=$(dapp create DSValue)
        const saiPepContract = new DSValue(this.connector, this.accountManager, await this.simpleDeploy("DSValue"), this.connector.gasPrice)

        saiPipContract.poke( this.defaultMakerPriceInUsd )
        return {saiPipContract, saiPepContract};
    }

    private async deployTokens() {
        // test -z $SAI_GEM && GEMtx=$(dapp create DSToken $(seth --to-bytes32 $(seth --from-ascii 'ETH')))
        const saiGemContract = new WETH9(this.connector, this.accountManager, await this.simpleDeploy("WETH9"), this.connector.gasPrice);
        // await wethContract.deposit({attachedEth: new BN(1000)})

        // test -z $SAI_GOV && GOVtx=$(dapp create DSToken $(seth --to-bytes32 $(seth --from-ascii 'GOV')))
        const saiGovContract = new DSToken(this.connector, this.accountManager, await this.simpleDeploy("DSToken", [stringTo32ByteHex("GOV")]), this.connector.gasPrice)
        return {saiGemContract, saiGovContract};
    }

    private async deployDaiFab() {
        const gemFabContract = new GemFab(this.connector, this.accountManager, await this.simpleDeploy("GemFab"), this.connector.gasPrice);
        const voxFabContract = new VoxFab(this.connector, this.accountManager, await this.simpleDeploy("VoxFab"), this.connector.gasPrice);
        const tubFabContract = new TubFab(this.connector, this.accountManager, await this.simpleDeploy("TubFab"), this.connector.gasPrice);
        const tapFabContract = new TapFab(this.connector, this.accountManager, await this.simpleDeploy("TapFab"), this.connector.gasPrice);
        const topFabContract = new TopFab(this.connector, this.accountManager, await this.simpleDeploy("TopFab"), this.connector.gasPrice);
        const momFabContract = new MomFab(this.connector, this.accountManager, await this.simpleDeploy("MomFab"), this.connector.gasPrice);
        const dadFabContract = new DadFab(this.connector, this.accountManager, await this.simpleDeploy("DadFab"), this.connector.gasPrice);

        // DAI_FAB=$(dapp create DaiFab $GEM_FAB $VOX_FAB $TUB_FAB $TAP_FAB $TOP_FAB $MOM_FAB $DAD_FAB)
        const daiFabAddress = await this.simpleDeploy("DaiFab", [
            gemFabContract.address,
            voxFabContract.address,
            tubFabContract.address,
            tapFabContract.address,
            topFabContract.address,
            momFabContract.address,
            dadFabContract.address,
        ]);
        return new DaiFab(this.connector, this.accountManager, daiFabAddress, this.connector.gasPrice);
    }

    private async simpleDeploy(contractName: string, constructorArgs?: Array<any>): Promise<string> {
        return await this.construct(this.contracts.get(contractName), constructorArgs || [], `Uploading ${contractName}`);
    }

    private static getEncodedConstructData(abi: Abi, bytecode: Buffer, constructorArgs: Array<string>): Buffer {
        if (constructorArgs.length === 0) {
            return bytecode;
        }
        const constructorSignature = abi.find((signature: AbiFunction | AbiEvent): signature is AbiFunction => signature.type === 'constructor');
        if (typeof constructorSignature === 'undefined') throw new Error(`ABI did not contain a constructor.`);
        const constructorInputTypes = constructorSignature.inputs.map(x => x.type);
        const encodedConstructorParameters = Buffer.from(encodeParams(constructorInputTypes, constructorArgs).substring(2), 'hex');
        return Buffer.concat([bytecode, encodedConstructorParameters]);
    }

    private async construct(contract: Contract, constructorArgs: Array<string>, failureDetails: string): Promise<string> {
        const data = `0x${ContractDeployer.getEncodedConstructData(contract.abi, contract.bytecode, constructorArgs).toString('hex')}`;
        const gasEstimate = await this.connector.ethjsQuery.estimateGas({
            from: this.accountManager.defaultAddress,
            data: data
        });
        const nonce = await this.accountManager.nonces.get(this.accountManager.defaultAddress);
        const signedTransaction = await this.accountManager.signTransaction({
            gas: gasEstimate,
            gasPrice: this.connector.gasPrice,
            data: data
        });
        console.log(`Upload contract: ${contract.contractName} nonce: ${nonce}, gas: ${gasEstimate}, gasPrice: ${this.connector.gasPrice}`);
        const transactionHash = await this.connector.ethjsQuery.sendRawTransaction(signedTransaction);
        const receipt = await this.connector.waitForTransactionReceipt(transactionHash, failureDetails);
        console.log(`Uploaded contract: ${contract.contractName}: \"${receipt.contractAddress}\"`);
        return receipt.contractAddress;
    }

    private async generateAddressMappingEnvFile(contractAddressMapping: ContractAddressMapping): Promise<string> {
        return `ETHEREUM_OASIS_ADDRESS=${contractAddressMapping.oasisDex}\n` +
            `ETHEREUM_MAKER_ADRESS=${contractAddressMapping.tub}\n`;

    }

    private async generateAddressMappingFile(contractAddressMapping: ContractAddressMapping): Promise<void> {
        const addressMappingJson = JSON.stringify(contractAddressMapping, null, ' ');;
        const addressMappingEnvFile = await this.generateAddressMappingEnvFile(contractAddressMapping);
        await writeFile(this.configuration.contractAddressesOutputPathJson, addressMappingJson, 'utf8')
        await writeFile(this.configuration.contractAddressesOutputPathEnvFile, addressMappingEnvFile, 'utf8')
    }
}
