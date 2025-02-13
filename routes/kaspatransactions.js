const express = require('express');
const router = express.Router();
const KaspaTransactions = require('../utils/kaspaTransactions');
const KaspaFeeEstimator = require('../utils/kaspaFeeEstimator');

// Test route to verify the router is working
router.get('/test', (req, res) => {
    res.json({ message: 'Kaspa transactions router is working' });
});

router.post('/send', async (req, res) => {
    let transactionManager = null;
    try {
        const { fromPrivateKey, toAddress, amount, network = 'testnet-10', priorityFee } = req.body;

        // Validate required fields
        if (!fromPrivateKey) {
            return res.status(400).json({ success: false, error: 'Source private key is required' });
        }
        if (!toAddress) {
            return res.status(400).json({ success: false, error: 'Destination address is required' });
        }
        if (!amount) {
            return res.status(400).json({ success: false, error: 'Amount is required' });
        }

        console.log('Processing transaction request...');
        console.log('To address:', toAddress);
        console.log('Amount:', amount, 'KAS');
        
        transactionManager = new KaspaTransactions(network);
        const result = await transactionManager.sendTransaction(fromPrivateKey, toAddress, amount, priorityFee);
        
        res.json(result);
    } catch (error) {
        console.error('Error processing transaction:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    } finally {
        if (transactionManager) {
            await transactionManager.cleanup();
        }
    }
});

router.post('/estimate-fee', async (req, res) => {
    console.log('Received estimate-fee request');
    let feeEstimator = null;
    try {
        const { fromPrivateKey, toAddress, amount, network = 'testnet-10' } = req.body;
        console.log('Request body:', { toAddress, amount, network });

        // Validate required fields
        if (!fromPrivateKey) {
            return res.status(400).json({ success: false, error: 'Source private key is required' });
        }
        if (!toAddress) {
            return res.status(400).json({ success: false, error: 'Destination address is required' });
        }
        if (!amount) {
            return res.status(400).json({ success: false, error: 'Amount is required' });
        }

        console.log('Processing fee estimation request...');
        console.log('To address:', toAddress);
        console.log('Amount:', amount, 'KAS');
        
        feeEstimator = new KaspaFeeEstimator(network);
        const estimation = await feeEstimator.estimateTransactionFee(fromPrivateKey, toAddress, amount);
        
        res.json({
            success: true,
            estimation
        });
    } catch (error) {
        console.error('Error estimating fee:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    } finally {
        if (feeEstimator) {
            await feeEstimator.cleanup();
        }
    }
});

module.exports = router; 