// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    Wallet, setDefaultStorageFolder,
    AccountKind, Resolver,
    NetworkId, Mnemonic,
    XPrv, NetworkType
} = kaspa;

class WalletBlankCreator {
    constructor(networkType = 'testnet-10') {
        this.wallet = null;
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType.includes('testnet') ? NetworkType.Testnet : NetworkType.Mainnet;
        this.setupStorage();
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
            if (!this.wallet) {
                console.log('Initializing new wallet...');
                this.wallet = new Wallet({
                    resident: false,
                    networkId: this.networkId,
                    resolver: new Resolver()
                });
                console.log('Wallet instance created');

                this.wallet.addEventListener(({ type, data }) => {
                    console.log(`Event ${type}:`, data);
                });
                console.log('Event listeners attached');
            }
            return this.wallet;
        } catch (error) {
            console.error('Error in initialize:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    generatePrivateKey() {
        // Generate a random mnemonic for entropy
        const mnemonic = Mnemonic.random(24);
        console.log('Generated mnemonic for entropy');
        
        // Create seed and master key
        const seed = mnemonic.toSeed();
        console.log('Generated seed');
        
        // Create master private key
        const xPrv = new XPrv(seed);
        console.log('Created master private key');

        // Derive the private key using Kaspa's derivation path
        const derivedPrivKey = xPrv.derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
        console.log('Derived private key');

        // Get the address to verify
        const address = derivedPrivKey.toAddress(this.networkType);
        console.log('Generated address:', address.toString());

        return {
            privateKey: derivedPrivKey.toString(),
            address: address.toString()
        };
    }

    async createBlankWallet() {
        try {
            console.log('Starting blank wallet creation...');
            await this.initialize();
            
            // Generate a secure private key
            const { privateKey, address } = this.generatePrivateKey();
            const filename = `wallet_${Date.now()}`;
            console.log('Generated privateKey and filename');

            // Create wallet file
            console.log('Creating wallet...');
            if (!await this.wallet.exists(filename)) {
                await this.wallet.walletCreate({
                    walletSecret: privateKey,
                    filename,
                    title: "Blank Wallet"
                });
            }
            console.log('Wallet created');

            // Open wallet
            console.log('Opening wallet...');
            await this.wallet.walletOpen({
                walletSecret: privateKey,
                filename,
                accountDescriptors: false
            });
            console.log('Wallet opened');

            // Create default account
            console.log('Creating default account...');
            await this.wallet.accountsEnsureDefault({
                walletSecret: privateKey,
                type: new AccountKind("bip32")
            });
            console.log('Default account created');

            // Connect to rpc
            console.log('Connecting wallet...');
            await this.wallet.connect();
            console.log('Wallet connected');

            // Start wallet processing
            console.log('Starting wallet...');
            await this.wallet.start();
            console.log('Wallet started');

            // List accounts
            console.log('Getting account descriptors...');
            const accounts = await this.wallet.accountsEnumerate({});
            const accountDescriptor = accounts.accountDescriptors[0];
            console.log('Account descriptor:', accountDescriptor);

            // Activate Account
            console.log('Activating account...');
            await this.wallet.accountsActivate({
                accountIds: [accountDescriptor.accountId]
            });
            console.log('Account activated');

            const result = {
                privateKey: privateKey,
                publicKey: accountDescriptor.receiveAddress.toString(),
                address: address
            };

            console.log('Final response format:', JSON.stringify(result, null, 2));

            // Close the wallet after getting all necessary information
            console.log('Closing wallet...');
            try {
                await this.wallet.stop();
                await this.wallet.disconnect();
                await this.wallet.walletClose({});
                this.wallet = null; // Clear the instance
                console.log('Wallet closed successfully');
            } catch (closeError) {
                console.error('Error closing wallet:', closeError);
                // Don't throw here as we still want to return the wallet info
            }

            console.log('Blank wallet creation completed:', result);
            return result;
        } catch (error) {
            console.error('Error in createBlankWallet:', error);
            console.error('Stack:', error.stack);
            
            // Try to close the wallet even if there was an error
            if (this.wallet) {
                try {
                    await this.wallet.stop();
                    await this.wallet.disconnect();
                    await this.wallet.walletClose({});
                    this.wallet = null; // Clear the instance
                    console.log('Wallet closed after error');
                } catch (closeError) {
                    console.error('Error closing wallet after error:', closeError);
                }
            }
            
            throw error;
        }
    }

    // Add cleanup method for external use if needed
    async cleanup() {
        if (this.wallet) {
            try {
                await this.wallet.stop();
                await this.wallet.disconnect();
                await this.wallet.walletClose({});
                this.wallet = null;
                console.log('Wallet cleanup completed');
            } catch (error) {
                console.error('Error during wallet cleanup:', error);
                throw error;
            }
        }
    }
}

module.exports = WalletBlankCreator; 