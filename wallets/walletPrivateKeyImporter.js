// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    setDefaultStorageFolder,
    Resolver, NetworkId,
    NetworkType, RpcClient,
    UtxoProcessor, UtxoContext,
    PrivateKey, Wallet
} = kaspa;

class WalletPrivateKeyImporter {
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

    async importFromPrivateKey(privateKeyStr) {
        try {
            console.log('Starting wallet import from private key...');
            await this.initialize();

            // Create private key object
            const privateKey = new PrivateKey(privateKeyStr);
            console.log('Created private key from string');

            // Get the keypair and address
            const keypair = privateKey.toKeypair();
            const address = keypair.toAddress(this.networkType);
            console.log('Generated address:', address.toString());

            // Create UTXO context and track address
            const context = new UtxoContext({ processor: this.processor });
            await context.trackAddresses([address.toString()]);
            console.log('Tracking address for UTXOs');

            // Format response to match WalletImportResponse struct
            const result = {
                privateKey: privateKeyStr,
                publicKey: address.toString(), // Using address as publicKey to match client expectations
                address: address.toString()
            };
            
            console.log('Wallet import completed:', result);
            return result;
        } catch (error) {
            console.error('Error in importFromPrivateKey:', error);
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

module.exports = WalletPrivateKeyImporter; 