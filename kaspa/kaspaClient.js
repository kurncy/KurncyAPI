// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    Wallet, setDefaultStorageFolder,
    AccountKind, Mnemonic, Resolver,
    kaspaToSompi,
    sompiToKaspaString,
    NetworkId
} = kaspa;

class KaspaClient {
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
                    switch (type) {
                        case "balance":
                            console.log("Balance update:", sompiToKaspaString(data.balance.mature));
                            break;
                        case "maturity":
                        case "pending":
                            console.log(`Transaction ${type}:`, data.id);
                            break;
                        default:
                            console.log(`Event ${type}:`, data);
                    }
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

    async createWallet() {
        try {
            console.log('Starting createWallet...');
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
            console.log('Wallet creation completed:', result);
            return result;
        } catch (error) {
            console.error('Error in createWallet:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    async importWallet(mnemonic, filename) {
        const wallet = await this.initialize();
        const privateKey = "key_" + Date.now();

        // Create private key from mnemonic
        const prvKeyData = await wallet.prvKeyDataCreate({
            walletSecret: privateKey,
            mnemonic
        });

        // Create wallet with imported key
        await wallet.walletCreate({
            walletSecret: privateKey,
            filename,
            title: "Imported Wallet"
        });

        // Create account with imported key
        const account = await wallet.accountsCreate({
            walletSecret: privateKey,
            type: "bip32",
            accountName: "Imported Account",
            prvKeyDataId: prvKeyData.prvKeyDataId
        });

        await wallet.connect();
        await wallet.start();

        return {
            walletId: filename,
            privateKey: privateKey,
            address: account.receiveAddress
        };
    }

    async importWalletFromPrivateKey(privateKey) {
        const wallet = await this.initialize();
        const filename = `wallet_${Date.now()}`;

        // Create wallet with the private key
        await wallet.walletCreate({
            walletSecret: privateKey,
            filename,
            title: "Imported Wallet"
        });

        // Open wallet
        await wallet.walletOpen({
            walletSecret: privateKey,
            filename,
            accountDescriptors: false
        });

        // Create default account
        await wallet.accountsEnsureDefault({
            walletSecret: privateKey,
            type: new AccountKind("bip32")
        });

        // Connect and start
        await wallet.connect();
        await wallet.start();

        // Get account info
        const accounts = await wallet.accountsEnumerate({});
        const account = accounts.accountDescriptors[0];

        return {
            walletId: filename,
            privateKey: privateKey,
            receiveAddress: account.receiveAddress,
            changeAddress: account.changeAddress
        };
    }

    async getBalance(address) {
        const wallet = await this.initialize();
        const accounts = await wallet.accountsEnumerate({});
        const account = accounts.accountDescriptors.find(a => a.receiveAddress === address);
        
        if (!account) {
            throw new Error("Address not found in wallet");
        }

        await wallet.accountsActivate({
            accountIds: [account.accountId]
        });

        const balance = await wallet.getBalance(account.accountId);
        return {
            mature: sompiToKaspaString(balance.mature),
            pending: sompiToKaspaString(balance.pending),
            outgoing: sompiToKaspaString(balance.outgoing)
        };
    }

    async createTransaction(fromAddress, toAddress, amount, walletSecret) {
        const wallet = await this.initialize();
        const accounts = await wallet.accountsEnumerate({});
        const account = accounts.accountDescriptors.find(a => a.receiveAddress === fromAddress);

        if (!account) {
            throw new Error("Source address not found in wallet");
        }

        const result = await wallet.accountsSend({
            walletSecret,
            accountId: account.accountId,
            priorityFeeSompi: kaspaToSompi("0.001"),
            destination: [{
                address: toAddress,
                amount: kaspaToSompi(amount)
            }]
        });

        return result;
    }

    async createBlankWallet() {
        const wallet = await this.initialize();
        const filename = `wallet_${Date.now()}`;

        // Generate a new private key (using current timestamp and random number for entropy)
        const timestamp = Date.now().toString();
        const random = Math.random().toString();
        const entropy = timestamp + random;
        const privateKey = Buffer.from(entropy).toString('hex').substring(0, 64); // 32 bytes hex

        // Create wallet with the generated private key
        await wallet.walletCreate({
            walletSecret: privateKey,
            filename,
            title: "Blank Wallet"
        });

        // Open wallet
        await wallet.walletOpen({
            walletSecret: privateKey,
            filename,
            accountDescriptors: false
        });

        // Create default account
        await wallet.accountsEnsureDefault({
            walletSecret: privateKey,
            type: new AccountKind("bip32")
        });

        // Connect and start
        await wallet.connect();
        await wallet.start();

        // Get account info
        const accounts = await wallet.accountsEnumerate({});
        const account = accounts.accountDescriptors[0];

        return {
            walletId: filename,
            privateKey: privateKey,
            receiveAddress: account.receiveAddress,
            changeAddress: account.changeAddress
        };
    }
}

// Export a factory function instead of a singleton
module.exports = {
    createClient: (networkType) => new KaspaClient(networkType),
    // Create convenience instances for common networks
    mainnet: new KaspaClient('mainnet'),
    testnet10: new KaspaClient('testnet-10'),
    testnet11: new KaspaClient('testnet-11')
}; 