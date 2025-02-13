// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    Wallet, setDefaultStorageFolder,
    AccountKind, Resolver,
    NetworkId, Mnemonic,
    XPrv, NetworkType,
    PrivateKey, RpcClient,
    UtxoProcessor, UtxoContext,
    kaspaToSompi
} = kaspa;

const WalletMnemonicImporter = require('./walletMnemonicImporter');
const WalletPrivateKeyImporter = require('./walletPrivateKeyImporter');

class WalletImporter {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType.includes('testnet') ? NetworkType.Testnet : NetworkType.Mainnet;
        this.setupStorage();
        this.rpc = null;
        this.processor = null;
        this.mnemonicImporter = new WalletMnemonicImporter(networkType);
        this.privateKeyImporter = new WalletPrivateKeyImporter(networkType);
    }

    setupStorage() {
        const storageFolder = path.join(__dirname, '../../../data/wallets');
        if (!fs.existsSync(storageFolder)) {
            fs.mkdirSync(storageFolder, { recursive: true });
        }
        setDefaultStorageFolder(storageFolder);
    }

    async initialize() {
        try {
            if (!this.rpc) {
                console.log('Initializing RPC client...');
                this.rpc = new RpcClient({
                    resolver: new Resolver(),
                    networkId: this.networkId
                });
                await this.rpc.connect();
                console.log('RPC client connected');

                const { isSynced } = await this.rpc.getServerInfo();
                if (!isSynced) {
                    throw new Error("Please wait for the node to sync");
                }
            }

            if (!this.processor) {
                console.log('Initializing UTXO processor...');
                this.processor = new UtxoProcessor({ rpc: this.rpc, networkId: this.networkId });
                await this.processor.start();
                console.log('UTXO processor started');

                this.processor.addEventListener("utxo-proc-start", (event) => {
                    console.log("UTXO processor event:", event);
                });
            }

            return { rpc: this.rpc, processor: this.processor };
        } catch (error) {
            console.error('Error in initialize:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    async importFromMnemonic(mnemonic) {
        return await this.mnemonicImporter.importFromMnemonic(mnemonic);
    }

    async importFromPrivateKey(privateKeyStr) {
        return await this.privateKeyImporter.importFromPrivateKey(privateKeyStr);
    }

    async cleanup() {
        await this.mnemonicImporter.cleanup();
        await this.privateKeyImporter.cleanup();
    }
}

module.exports = WalletImporter; 