const express = require('express');
const router = express.Router();
const WalletCreator = require('../wallets/walletCreator');
const WalletBlankCreator = require('../wallets/walletBlankCreator');
const WalletImporter = require('../wallets/walletImporter');
const EncryptionManager = require('../encryption/encryptionManager');

// Create new wallet with mnemonic
router.post('/create', async (req, res) => {
    try {
        console.log('Starting wallet creation...');
        const { network = 'testnet-10', pin } = req.body;
        if (!pin) {
            return res.status(400).json({ error: 'PIN is required for encryption' });
        }
        console.log('Using network:', network);
        
        const creator = new WalletCreator(network);
        const walletData = await creator.createWalletWithMnemonic();
        
        // Encrypt the private key with the PIN
        const encryptedPrivateKey = await EncryptionManager.encrypt(walletData.privateKey, pin);
        
        // Return the response with encrypted private key
        const response = {
            ...walletData,
            privateKey: encryptedPrivateKey // Replace raw private key with encrypted data
        };
        
        console.log('Wallet created with encrypted private key');
        res.json(response);
    } catch (error) {
        console.error('Error creating wallet:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Create new blank wallet (just private key)
router.post('/create/blank', async (req, res) => {
    try {
        console.log('Starting blank wallet creation...');
        const { network = 'testnet-10', pin } = req.body;
        if (!pin) {
            return res.status(400).json({ error: 'PIN is required for encryption' });
        }
        console.log('Using network:', network);
        
        const creator = new WalletBlankCreator(network);
        const walletData = await creator.createBlankWallet();
        
        // Encrypt the private key with the PIN
        const encryptedPrivateKey = await EncryptionManager.encrypt(walletData.privateKey, pin);
        
        // Return the response with encrypted private key
        const response = {
            ...walletData,
            privateKey: encryptedPrivateKey // Replace raw private key with encrypted data
        };
        
        console.log('Blank wallet created with encrypted private key');
        res.json(response);
    } catch (error) {
        console.error('Error creating blank wallet:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Import wallet using mnemonic
router.post('/import/mnemonic', async (req, res) => {
    try {
        const { mnemonic, network = 'testnet-10', pin } = req.body;
        if (!mnemonic) {
            return res.status(400).json({ error: 'Mnemonic is required' });
        }
        if (!pin) {
            return res.status(400).json({ error: 'PIN is required for encryption' });
        }

        const importer = new WalletImporter(network);
        const walletData = await importer.importFromMnemonic(mnemonic);
        
        // Encrypt the private key with the PIN
        const encryptedPrivateKey = await EncryptionManager.encrypt(walletData.privateKey, pin);
        
        // Return the response with encrypted private key
        const response = {
            ...walletData,
            privateKey: encryptedPrivateKey // Replace raw private key with encrypted data
        };
        
        console.log('Wallet imported from mnemonic with encrypted private key');
        res.json(response);
    } catch (error) {
        console.error('Error importing wallet from mnemonic:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Import wallet using private key
router.post('/import/privatekey', async (req, res) => {
    try {
        const { privateKey, network = 'testnet-10', pin } = req.body;
        if (!privateKey) {
            return res.status(400).json({ error: 'Private key is required' });
        }
        if (!pin) {
            return res.status(400).json({ error: 'PIN is required for encryption' });
        }
        
        const importer = new WalletImporter(network);
        const walletData = await importer.importFromPrivateKey(privateKey);
        
        // Encrypt the private key with the PIN
        const encryptedPrivateKey = await EncryptionManager.encrypt(walletData.privateKey, pin);
        
        // Return the response with encrypted private key
        const response = {
            ...walletData,
            privateKey: encryptedPrivateKey // Replace raw private key with encrypted data
        };
        
        console.log('Wallet import completed with encrypted private key');
        res.json(response);
    } catch (error) {
        console.error('Error importing wallet:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

module.exports = router; 