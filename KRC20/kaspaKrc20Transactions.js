// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const KaspaKrc20FeeEstimator = require('./kaspaKrc20FeeEstimator');
const {
    setDefaultStorageFolder,
    Resolver, NetworkId,
    NetworkType, RpcClient,
    UtxoProcessor, UtxoContext,
    Generator, PrivateKey,
    ScriptBuilder, Opcodes,
    addressFromScriptPublicKey,
    kaspaToSompi,
    Encoding,
    createTransactions
} = kaspa;

// 1 Kaspa = 100000000 Sompi
const SOMPI_PER_KASPA = 100000000n;
const DEFAULT_PRIORITY_FEE = "0";
const TRANSACTION_TIMEOUT = 120000; // 2 minutes
const DEFAULT_GAS_FEE = "0.3";  // Fixed gas fee for KRC20 transactions

function kaspaToSompiStr(amount) {
    return BigInt(Math.floor(Number(amount) * Number(SOMPI_PER_KASPA))).toString();
}

class KaspaKrc20Transactions {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);  // Use the exact network type
        this.networkType = networkType === 'testnet-10' ? NetworkType.Testnet : NetworkType.Mainnet;
        this.setupStorage();
        this.rpc = null;
        this.utxoProcessor = null;
        this.utxoContext = null;
        this.eventReceived = false;
        this.submittedTxId = null;
        this.addedEventTxId = null;
        this.feeEstimator = new KaspaKrc20FeeEstimator(networkType);
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
            console.log('Initializing RPC client...');
            this.rpc = new RpcClient({
                resolver: new Resolver(),
                encoding: Encoding.Borsh,
                networkId: this.networkId
            });
            await this.rpc.connect();
            console.log('RPC client connected');

            const { isSynced } = await this.rpc.getServerInfo();
            if (!isSynced) {
                throw new Error("Please wait for the node to sync");
            }
        } catch (error) {
            console.error('Error in initialize:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    setupUtxoListener(address) {
        this.rpc.addEventListener('utxos-changed', async (event) => {
            console.log(`UTXO changes detected for address: ${address}`);
            
            // Custom replacer for JSON.stringify to handle BigInt
            const replacer = (key, value) => {
                if (typeof value === 'bigint') {
                    return value.toString();
                }
                return value;
            };
            
            try {
                console.log('Event data:', JSON.stringify(event.data, replacer, 2));
            } catch (error) {
                console.log('Could not stringify full event data:', error.message);
            }
            
            const removedEntry = event.data.removed.find((entry) => 
                entry.address.payload === address.split(':')[1]
            );
            const addedEntry = event.data.added.find((entry) => 
                entry.address.payload === address.split(':')[1]
            );    

            if (addedEntry) {
                console.log('Added UTXO found');
                try {
                    console.log('Added entry details:', JSON.stringify(addedEntry, replacer, 2));
                } catch (error) {
                    console.log('Could not stringify added entry:', error.message);
                }
                
                this.addedEventTxId = addedEntry.outpoint.transactionId;
                console.log(`Added UTXO TransactionId: ${this.addedEventTxId}`);
                console.log(`Submitted TxId: ${this.submittedTxId}`);
                
                // Check if this UTXO corresponds to our transaction
                if (this.addedEventTxId === this.submittedTxId) {
                    console.log('Transaction confirmed!');
                    this.eventReceived = true;
                }
            }
        });
    }

    async waitForTransaction(timeout, txId) {
        console.log(`Waiting for transaction confirmation: ${txId}`);
        const startTime = Date.now();
        let confirmed = false;

        while (!confirmed && Date.now() - startTime < timeout) {
            try {
                // Check UTXO event confirmation
                if (this.eventReceived && this.addedEventTxId === txId) {
                    console.log(`Transaction ${txId} confirmed via UTXO event`);
                    // Wait additional time to ensure UTXO stability
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    confirmed = true;
                    break;
                }
            } catch (error) {
                console.log(`Error checking transaction status:`, error.message);
            }

            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between checks
        }

        if (!confirmed) {
            throw new Error(`Transaction timeout: ${txId}`);
        }
        console.log(`Transaction ${txId} confirmed successfully`);
        return confirmed;
    }

    async transferKrc20(fromPrivateKey, toAddress, amount, ticker, priorityFee = DEFAULT_PRIORITY_FEE) {
        let commitHash, revealHash;
        try {
            console.log('Starting KRC20 transfer...');
            await this.initialize();

            // Use fixed gas fee instead of estimation
            const gasFee = DEFAULT_GAS_FEE;
            console.log('Using fixed gas fee:', gasFee);

            // Create private key object and get source address
            const privateKey = new PrivateKey(fromPrivateKey);
            const publicKey = privateKey.toPublicKey();
            const sourceAddress = publicKey.toAddress(this.networkType);
            console.log('Source address:', sourceAddress.toString());

            // Estimate transaction fee first
            const feeEstimator = new KaspaKrc20FeeEstimator();  // Use default constructor
            await feeEstimator.initialize();  // Initialize with RPC connection
            const feeEstimation = await feeEstimator.estimateKrc20TransactionFee(fromPrivateKey, toAddress, amount, ticker);
            console.log('Fee estimation:', feeEstimation);
            await feeEstimator.cleanup();  // Clean up the fee estimator's RPC connection

            // Calculate total commit amount (gas fee + estimated commit fee)
            const totalCommitAmount = Number(DEFAULT_GAS_FEE) + Number(feeEstimation.commitFee);
            console.log('Total commit amount:', totalCommitAmount);

            // Subscribe to UTXO changes
            await this.rpc.subscribeUtxosChanged([sourceAddress.toString()]);
            this.setupUtxoListener(sourceAddress.toString());

            // Create KRC20 transfer data
            const data = {
                p: "krc-20",
                op: "transfer",
                tick: ticker,
                amt: (BigInt(amount) * 100000000n).toString(),  // Convert to sompi (1 KAS = 100000000 sompi)
                to: toAddress
            };

            console.log('Creating script with data:', JSON.stringify(data));

            // Create script with proper OPcodes
            const script = new ScriptBuilder()
                .addData(publicKey.toXOnlyPublicKey().toString())
                .addOp(Opcodes.OpCheckSig)
                .addOp(Opcodes.OpFalse)
                .addOp(Opcodes.OpIf)
                .addData(Buffer.from("kasplex"))
                .addI64(0n)
                .addData(Buffer.from(JSON.stringify(data)))
                .addOp(Opcodes.OpEndIf);

            const p2shAddress = addressFromScriptPublicKey(script.createPayToScriptHashScript(), this.networkType);
            console.log('P2SH Address:', p2shAddress.toString());
            
            // Step 1: Commit Transaction
            // Wait for initial UTXO stability
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const { entries } = await this.rpc.getUtxosByAddresses({ addresses: [sourceAddress.toString()] });
            if (!entries || entries.length === 0) {
                throw new Error('No UTXOs found for source address');
            }

            console.log('Creating commit transaction...');
            const { transactions } = await createTransactions({
                priorityEntries: [],  // Add empty priority entries
                entries,
                outputs: [{
                    address: p2shAddress.toString(),
                    amount: kaspaToSompi(totalCommitAmount.toString())  // Use total amount including estimated fee
                }],
                changeAddress: sourceAddress.toString(),
                priorityFee: kaspaToSompi(priorityFee),
                networkId: this.networkId
            });

            // Sign and submit commit transaction
            for (const transaction of transactions) {
                transaction.sign([privateKey]);
                commitHash = await transaction.submit(this.rpc);
                this.submittedTxId = commitHash;
                console.log('Commit transaction submitted:', commitHash);
            }

            // Wait for commit transaction to be processed
            this.eventReceived = false;
            await this.waitForTransaction(TRANSACTION_TIMEOUT, commitHash);
            
            // Wait for UTXO stability after commit
            console.log('Waiting for UTXO stability after commit...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('Commit transaction confirmed, proceeding with reveal...');
            
            // Step 2: Reveal Transaction
            console.log('Creating reveal transaction...');
            const { entries: currentEntries } = await this.rpc.getUtxosByAddresses({ addresses: [sourceAddress.toString()] });
            const revealUtxos = await this.rpc.getUtxosByAddresses({ addresses: [p2shAddress.toString()] });

            if (!revealUtxos.entries || revealUtxos.entries.length === 0) {
                throw new Error('No UTXOs found for P2SH address');
            }

            const { transactions: revealTransactions } = await createTransactions({
                priorityEntries: [revealUtxos.entries[0]],
                entries: currentEntries,
                outputs: [{
                    address: sourceAddress.toString(),
                    amount: kaspaToSompi(gasFee)  // Return the gas fee back to sender
                }],
                changeAddress: sourceAddress.toString(),
                priorityFee: kaspaToSompi(priorityFee),
                networkId: this.networkId
            });

            for (const transaction of revealTransactions) {
                transaction.sign([privateKey], false);
                const ourOutput = transaction.transaction.inputs.findIndex((input) => input.signatureScript === '');

                if (ourOutput !== -1) {
                    const signature = await transaction.createInputSignature(ourOutput, privateKey);
                    transaction.fillInput(ourOutput, script.encodePayToScriptHashSignatureScript(signature));
                }

                revealHash = await transaction.submit(this.rpc);
                this.submittedTxId = revealHash;
                console.log('Reveal transaction submitted:', revealHash);
            }

            // Wait for reveal transaction to be processed
            this.eventReceived = false;
            await this.waitForTransaction(TRANSACTION_TIMEOUT, revealHash);

            console.log('KRC20 transfer completed successfully');
            return {
                success: true,
                commitHash,
                revealHash
            };
        } catch (error) {
            console.error('Error in transferKrc20:', error);
            console.error('Stack:', error.stack);
            throw error;
        } finally {
            await this.cleanup();
        }
    }

    async cleanup() {
        if (this.rpc) {
            await this.rpc.disconnect();
        }
    }
}

module.exports = KaspaKrc20Transactions; 