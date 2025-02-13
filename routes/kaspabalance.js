const express = require('express');
const router = express.Router();
const WalletBalance = require('../wallets/walletBalance');
const UtxoCompound = require('../kaspa/utxoCompound'); // not working

router.get('/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const { network = 'testnet-10' } = req.query;

        console.log('Getting balance for address:', address);
        const balanceManager = new WalletBalance(network);
        
        try {
            const balance = await balanceManager.getBalance(address);
            res.json({ success: true, balance });
        } finally {
            await balanceManager.cleanup();
        }
    } catch (error) {
        console.error('Error getting balance:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Add compound route
router.post('/compound', async (req, res) => {
    try {
        const { fromPrivateKey, priorityFee = "0", network = 'testnet-10' } = req.body;

        if (!fromPrivateKey) {
            return res.status(400).json({ 
                success: false, 
                error: 'Private key is required' 
            });
        }

        console.log('Processing compound request...');
        const compoundManager = new UtxoCompound(network);
        const result = await compoundManager.compound(fromPrivateKey, priorityFee);
        
        res.json(result);
    } catch (error) {
        console.error('Error in compound operation:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Export the router directly
module.exports = router; 