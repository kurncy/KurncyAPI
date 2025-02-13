// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    setDefaultStorageFolder,
    Resolver, NetworkId,
    Mnemonic, XPrv,
    NetworkType, RpcClient,
    UtxoProcessor, UtxoContext
} = kaspa;

class WalletMnemonicImporter {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType.includes('testnet') ? NetworkType.Testnet : NetworkType.Mainnet;
        this.setupStorage();
        this.rpc = null;
        this.processor = null;
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
        try {
            console.log('Starting wallet import from mnemonic...');
            await this.initialize();

            // Create seed and master key from mnemonic
            const mnemonicObj = new Mnemonic(mnemonic.trim());
            const seed = mnemonicObj.toSeed();
            console.log('Generated seed from mnemonic');

            // Create master private key
            const xPrv = new XPrv(seed);
            console.log('Created master private key');

            // Derive the private key using Kaspa's derivation path
            const privateKey = xPrv.derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
            console.log('Derived private key');

            // Get the address
            const address = privateKey.toAddress(this.networkType);
            console.log('Generated address:', address.toString());

            // Create UTXO context and track address
            const context = new UtxoContext({ processor: this.processor });
            await context.trackAddresses([address.toString()]);
            console.log('Tracking address for UTXOs');

            const result = {
                privateKey: privateKey.toString(),
                address: address.toString()
            };
            console.log('Wallet import completed:', result);
            return result;
        } catch (error) {
            console.error('Error in importFromMnemonic:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    async cleanup() {
        if (this.processor) {
            await this.processor.stop();
        }
        if (this.rpc) {
            await this.rpc.disconnect();
        }
    }
}

module.exports = WalletMnemonicImporter; 