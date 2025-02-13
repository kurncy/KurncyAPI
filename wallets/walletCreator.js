// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    Wallet, setDefaultStorageFolder,
    AccountKind, Mnemonic, Resolver,
    NetworkId
} = kaspa;

class WalletCreator {
    constructor(networkType = 'testnet-10') {
        this.wallet = null;
        this.networkId = new NetworkId(networkType);
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

    async createWalletWithMnemonic() {
        try {
            console.log('Starting wallet creation with mnemonic...');
            const wallet = await this.initialize();
            console.log('Wallet initialized');

            const privateKey = "key_" + Date.now();
            const filename = `wallet_${Date.now()}`;
            console.log('Generated privateKey and filename');

            // Generate a new 24-word mnemonic
            console.log('Generating mnemonic...');
            const mnemonic = Mnemonic.random(24).phrase;
            console.log('Mnemonic generated');

            // First create the wallet file
            console.log('Creating wallet file...');
            await wallet.walletCreate({
                walletSecret: privateKey,
                filename,
                title: "Mobile Wallet"
            });
            console.log('Wallet file created');

            // Then open the wallet
            console.log('Opening wallet...');
            await wallet.walletOpen({
                walletSecret: privateKey,
                filename,
                accountDescriptors: false
            });
            console.log('Wallet opened');

            // Now create private key from mnemonic
            console.log('Creating private key data...');
            const prvKeyData = await wallet.prvKeyDataCreate({
                walletSecret: privateKey,
                mnemonic
            });
            console.log('Private key data created');

            // Create account with the private key
            console.log('Creating account...');
            const account = await wallet.accountsCreate({
                walletSecret: privateKey,
                type: "bip32",
                accountName: "Default Account",
                prvKeyDataId: prvKeyData.prvKeyDataId
            });
            console.log('Account created:', account);

            // Connect and start
            console.log('Connecting wallet...');
            await wallet.connect();
            console.log('Starting wallet...');
            await wallet.start();
            console.log('Wallet started');

            // Get account info after wallet is started
            console.log('Getting account descriptors...');
            const accounts = await wallet.accountsEnumerate({});
            const accountDescriptor = accounts.accountDescriptors[0];
            console.log('Account descriptor:', accountDescriptor);

            // Activate the account
            console.log('Activating account...');
            await wallet.accountsActivate({
                accountIds: [accountDescriptor.accountId]
            });
            console.log('Account activated');

            const result = {
                walletId: filename,
                privateKey: privateKey,
                mnemonic: mnemonic,
                receiveAddress: accountDescriptor.receiveAddress,
                changeAddress: accountDescriptor.changeAddress
            };

            // Close the wallet after getting all necessary information
            console.log('Closing wallet...');
            try {
                await wallet.stop();
                await wallet.disconnect();
                await wallet.walletClose({});
                console.log('Wallet closed successfully');
            } catch (closeError) {
                console.error('Error closing wallet:', closeError);
                // Don't throw here as we still want to return the wallet info
            }

            console.log('Wallet creation completed:', result);
            return result;
        } catch (error) {
            console.error('Error in createWalletWithMnemonic:', error);
            console.error('Stack:', error.stack);
            
            // Try to close the wallet even if there was an error
            if (this.wallet) {
                try {
                    await this.wallet.stop();
                    await this.wallet.disconnect();
                    await this.wallet.walletClose({});
                    console.log('Wallet closed after error');
                } catch (closeError) {
                    console.error('Error closing wallet after error:', closeError);
                }
            }
            
            throw error;
        }
    }
}

module.exports = WalletCreator; 