const express = require('express');
const router = express.Router();
const KaspaKrc20Transactions = require('../utils/kaspaKrc20Transactions');
const KaspaKrc20FeeEstimator = require('../utils/kaspaKrc20FeeEstimator');
const KaspaKrc20Minter = require('../utils/kaspaKrc20Minter'); // not used
const KaspaKrc20MinterUtils = require('../utils/kaspaKrc20MinterUtils');
const KaspaKrc20KurncyMinter = require('../utils/kaspaKrc20KurncyMinter');
const KaspaKrc20MintFeeEstimator = require('../utils/kaspaKrc20MintFeeEstimator');

router.post('/transfer', async (req, res) => {
    try {
        const { 
            fromPrivateKey, 
            toAddress, 
            amount,
            ticker,
            network = 'testnet-10', 
            priorityFee 
        } = req.body;

        console.log('Received request body:', JSON.stringify(req.body, null, 2));
        
        // Validate required fields
        if (!fromPrivateKey) {
            return res.status(400).json({ 
                success: false, 
                error: 'Source private key is required' 
            });
        }
        if (!toAddress) {
            return res.status(400).json({ 
                success: false, 
                error: 'Destination address is required' 
            });
        }
        if (!amount) {
            return res.status(400).json({ 
                success: false, 
                error: 'Amount is required' 
            });
        }
        if (!ticker) {
            return res.status(400).json({ 
                success: false, 
                error: 'Token ticker is required' 
            });
        }

        // Validate and parse amount
        const numericAmount = Number(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Amount must be a positive number'
            });
        }

        // Keep amount as string but ensure it's a valid integer
        const transferAmount = amount.toString().replace(/\.0+$/, '');

        console.log('Processing KRC20 transfer request...');
        console.log('To address:', toAddress);
        console.log('Amount:', transferAmount, 'tokens');
        console.log('Ticker:', ticker);
        
        const transactionManager = new KaspaKrc20Transactions(network);
        const result = await transactionManager.transferKrc20(
            fromPrivateKey,
            toAddress,
            transferAmount,
            ticker,
            priorityFee
        );
        
        res.json({
            ...result,
            transferDetails: {
                amount: transferAmount,
                ticker,
                toAddress
            }
        });
    } catch (error) {
        console.error('Error processing KRC20 transfer:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// New route for KRC20 fee estimation
router.post('/estimate-fee', async (req, res) => {
    try {
        const { 
            fromPrivateKey, 
            toAddress, 
            amount,
            ticker,
            network = 'testnet-10'
        } = req.body;

        // Validate required fields
        if (!fromPrivateKey) {
            return res.status(400).json({ 
                success: false, 
                error: 'Source private key is required' 
            });
        }
        if (!toAddress) {
            return res.status(400).json({ 
                success: false, 
                error: 'Destination address is required' 
            });
        }
        if (!amount) {
            return res.status(400).json({ 
                success: false, 
                error: 'Amount is required' 
            });
        }
        if (!ticker) {
            return res.status(400).json({ 
                success: false, 
                error: 'Token ticker is required' 
            });
        }

        console.log('Processing KRC20 fee estimation request...');
        console.log('To address:', toAddress);
        console.log('Amount:', amount, 'tokens');
        console.log('Ticker:', ticker);
        
        const feeEstimator = new KaspaKrc20FeeEstimator(network);
        const estimation = await feeEstimator.estimateKrc20TransactionFee(
            fromPrivateKey,
            toAddress,
            amount,
            ticker
        );
        
        res.json({
            success: true,
            estimation
        });
    } catch (error) {
        console.error('Error estimating KRC20 fee:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// New route for KRC20 minting
router.post('/mint', async (req, res) => {
    try {
        const { 
            fromPrivateKey, 
            ticker,
            network = 'testnet-10',
            priorityFee,
            iterations 
        } = req.body;

        // Validate required fields
        if (!fromPrivateKey) {
            return res.status(400).json({ 
                success: false, 
                error: 'Source private key is required' 
            });
        }
        if (!ticker) {
            return res.status(400).json({ 
                success: false, 
                error: 'Token ticker is required' 
            });
        }

        console.log('Processing KRC20 mint request...');
        console.log('Ticker:', ticker);
        console.log('Iterations:', iterations || 20);
        
        const minter = new KaspaKrc20Minter(network);
        const result = await minter.mintKrc20(
            fromPrivateKey,
            ticker,
            priorityFee,
            iterations
        );
        
        res.json({
            success: true,
            ...result,
            mintDetails: {
                network,
                ticker,
                iterations: iterations || 20
            }
        });
    } catch (error) {
        console.error('Error processing KRC20 mint:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// New mint2 route
router.post('/mint2', async (req, res) => {
    try {
        const { fromPrivateKey, ticker, priorityFee, iterations, network = 'testnet-10' } = req.body;

        if (!fromPrivateKey) {
            return res.status(400).json({ 
                success: false,
                error: 'Source private key is required' 
            });
        }

        if (!ticker) {
            return res.status(400).json({ 
                success: false,
                error: 'Token ticker is required' 
            });
        }

        console.log('Starting KRC20 mint2 process...');
        console.log('Network:', network);
        console.log('Ticker:', ticker);
        
        const minter = new KaspaKrc20MinterUtils(network);
        const result = await minter.mintKrc20(
            fromPrivateKey,
            ticker,
            priorityFee || "0",
            iterations || 20
        );

        return res.json({
            success: true,
            ...result,
            mintDetails: {
                network,
                ticker,
                iterations: iterations || 20
            }
        });
    } catch (error) {
        console.error('Error processing KRC20 mint2:', error);
        console.error('Error stack:', error.stack);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// New route for estimating mint fees
router.post('/estimate-mint-fee', async (req, res) => {
    try {
        const { fromPrivateKey, ticker, iterations, network = 'testnet-10' } = req.body;

        if (!fromPrivateKey) {
            return res.status(400).json({ 
                success: false,
                error: 'Source private key is required' 
            });
        }

        if (!ticker) {
            return res.status(400).json({ 
                success: false,
                error: 'Token ticker is required' 
            });
        }

        console.log('Estimating KRC20 mint fees...');
        console.log('Network:', network);
        console.log('Ticker:', ticker);
        console.log('Iterations:', iterations || 20);
        
        const estimator = new KaspaKrc20MintFeeEstimator(network);
        const result = await estimator.estimateMintFees(
            fromPrivateKey,
            ticker,
            iterations
        );

        return res.json(result);
    } catch (error) {
        console.error('Error estimating KRC20 mint fees:', error);
        console.error('Error stack:', error.stack);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// KURNCY specific minting route (fixed to mainnet, 280 iterations, kurncy ticker)
router.post('/mint3', async (req, res) => {
    try {
        const { fromPrivateKey, priorityFee } = req.body;

        if (!fromPrivateKey) {
            return res.status(400).json({ 
                success: false,
                error: 'Source private key is required' 
            });
        }

        console.log('Starting KURNCY specific minting process...');
        console.log('Network: mainnet');
        console.log('Ticker: kurncy');
        console.log('Iterations: 280');
        
        const minter = new KaspaKrc20KurncyMinter();
        const result = await minter.mintKrc20(
            fromPrivateKey,
            priorityFee || "0"
        );

        return res.json({
            success: true,
            ...result,
            mintDetails: {
                network: 'mainnet',
                ticker: 'kurncy',
                iterations: 280
            }
        });
    } catch (error) {
        console.error('Error processing KURNCY mint:', error);
        console.error('Error stack:', error.stack);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

module.exports = router; 