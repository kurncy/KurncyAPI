// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    Resolver, NetworkId,
    NetworkType, RpcClient,
    ScriptBuilder, Opcodes,
    PrivateKey,
    addressFromScriptPublicKey,
    kaspaToSompi,
    Generator,
    createTransactions,
    sompiToKaspa
} = kaspa;

const SOMPI_PER_KAS = 100000000n;

class KaspaKrc20CleanerUtils {
    constructor(networkType = 'mainnet') {
        console.log('Initializing KaspaKrc20CleanerUtils with network:', networkType);
        this.networkId = new NetworkId(networkType);
        // Fix the network type logic - if it's testnet-10, use Testnet, otherwise use Mainnet
        this.networkType = networkType === 'testnet-10' ? NetworkType.Testnet : NetworkType.Mainnet;
        console.log('Network type set to:', this.networkType === NetworkType.Testnet ? 'testnet' : 'mainnet');
        this.rpc = null;
        this.eventReceived = false;
        this.submittedTxId = null;
        this.addedEventTxId = null;
        this.currentWatchedAddress = null;
    }

    convertSompiToKas(sompi) {
        const sompiAmount = BigInt(sompi);
        return Number(sompiAmount) / Number(SOMPI_PER_KAS);
    }

    async initialize() {
        console.log('Initializing RPC client...');
        console.log('Using network ID:', this.networkId.toString());
        console.log('Using network type:', this.networkType === NetworkType.Testnet ? 'testnet' : 'mainnet');
        this.rpc = new RpcClient({
            resolver: new Resolver(),
            encoding: kaspa.Encoding.Borsh,
            networkId: this.networkId
        });
        await this.rpc.connect();
        console.log('RPC client connected');
    }

    setupUtxoListener(sourceAddress, p2shAddress) {
        this.rpc.addEventListener('utxos-changed', (event) => {
            console.log('UTXO changed event:', event);
            
            // Check for events on both addresses
            const watchedAddressPayload = this.currentWatchedAddress.split(':')[1];
            
            const removedEntry = event.data.removed.find((entry) => 
                entry.address && entry.address.payload === watchedAddressPayload
            );

            if (removedEntry) {
                console.log(`Found removed UTXO for address ${this.currentWatchedAddress}:`, removedEntry);
                if (this.submittedTxId) {
                    this.eventReceived = true;
                }
            }

            const addedEntry = event.data.added.find((entry) => 
                entry.address && entry.address.payload === watchedAddressPayload
            );    

            if (addedEntry) {
                console.log(`Found added UTXO for address ${this.currentWatchedAddress}:`, addedEntry);
                this.addedEventTxId = addedEntry.outpoint.transactionId;
                console.log('Added UTXO TransactionId:', this.addedEventTxId);
                if (this.addedEventTxId === this.submittedTxId) {
                    this.eventReceived = true;
                }
            }
        });
    }

    async waitForTransaction(timeout) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Transaction did not mature within the timeout period'));
            }, timeout);

            const checkEvent = setInterval(() => {
                if (this.eventReceived) {
                    clearTimeout(timeoutId);
                    clearInterval(checkEvent);
                    this.eventReceived = false;
                    this.addedEventTxId = null;  // Reset the added event txId
                    resolve();
                }
            }, 500);
        });
    }

    async cleanP2SHAddress(privateKey, ticker, priorityFee = "0") {
        const startTime = Date.now();
        try {
            await this.initialize();
            const gasFee = "1";
            const timeout = 30000;

            const privateKeyObj = new PrivateKey(privateKey);
            const publicKey = privateKeyObj.toPublicKey();
            const address = publicKey.toAddress(this.networkType);
            console.log('Source address:', address.toString());
            console.log('Network type:', this.networkType);

            // Create P2SH script for KRC20 minting
            const data = { 
                op: "mint", 
                p: "krc-20", 
                tick: ticker
            };

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
            console.log('P2SH address to clean:', p2shAddress.toString());

            // Check for balance in the P2SH address
            console.log('Checking balance for P2SH address...');
            const p2shUtxos = await this.rpc.getUtxosByAddresses([p2shAddress.toString()]);
            
            if (!p2shUtxos || !p2shUtxos.entries) {
                console.log('No UTXOs found for P2SH address');
                return {
                    status: 'clean',
                    message: 'No UTXOs found in P2SH address',
                    sourceAddress: address.toString(),
                    p2shAddress: p2shAddress.toString(),
                    totalBalance: "0",
                    duration: "0s"
                };
            }

            console.log('Found', p2shUtxos.entries.length, 'UTXOs');
            
            // Separate UTXOs based on their balance
            const regularUtxos = [];
            const smallUtxos = [];  // Changed from finalRevealUtxos to smallUtxos
            const processedTxIds = new Set(); // Track all processed txIds
            
            p2shUtxos.entries.forEach(utxo => {
                const utxoAmount = BigInt(utxo.amount);
                const utxoBalanceInKas = this.convertSompiToKas(utxo.amount);
                console.log('UTXO amount:', utxo.amount.toString(), '(', utxoBalanceInKas, 'KAS)');
                
                // 1.001 KAS = 100100000 sompi
                if (utxoAmount <= 200100000n) {
                    console.log('UTXO balance less than or equal to 1.001 KAS:', utxo.outpoint.transactionId);
                    smallUtxos.push(utxo);
                } else {
                    regularUtxos.push(utxo);
                }
            });
            
            const totalBalance = p2shUtxos.entries.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
            console.log('Calculated total balance:', totalBalance.toString());
            const balanceInKas = this.convertSompiToKas(totalBalance);
            console.log('Total balance in KAS:', balanceInKas);

            if (totalBalance <= 0n) {
                return {
                    status: 'clean',
                    message: 'No balance found in P2SH address',
                    sourceAddress: address.toString(),
                    p2shAddress: p2shAddress.toString(),
                    totalBalance: "0",
                    duration: "0s"
                };
            }

            // Calculate required iterations based on regular UTXOs only
            const results = [];
            let iterationCount = 0;

            // Subscribe to P2SH address
            console.log('Subscribing to P2SH address changes...');
            await this.rpc.subscribeUtxosChanged([p2shAddress.toString()]);
            this.setupUtxoListener(address.toString(), p2shAddress.toString());
            this.currentWatchedAddress = p2shAddress.toString();

            // Process regular UTXOs first
            if (regularUtxos.length > 0) {
                console.log('Processing regular UTXOs:', regularUtxos.length);
                let keepProcessing = true;
                let consecutiveFailures = 0;
                const MAX_CONSECUTIVE_FAILURES = 3;
                
                while (keepProcessing) {
                    try {
                        // Get current state of UTXOs
                        const currentUtxos = await this.rpc.getUtxosByAddresses([p2shAddress.toString()]);
                        if (!currentUtxos.entries || currentUtxos.entries.length === 0) {
                            console.log('No UTXOs remaining to process');
                            break;
                        }

                        // Filter out processed UTXOs and get valid ones, including newly created ones
                        const validUtxos = currentUtxos.entries.filter(utxo => {
                            const amount = BigInt(utxo.amount);
                            return amount > 200100000n && !processedTxIds.has(utxo.outpoint.transactionId);
                        });

                        if (validUtxos.length === 0) {
                            console.log('No valid unprocessed regular UTXOs remaining');
                            keepProcessing = false;
                            break;
                        }

                        // Process each valid UTXO
                        for (const currentUtxo of validUtxos) {
                            try {
                                const utxoBalanceInKas = this.convertSompiToKas(currentUtxo.amount);
                                const requiredIterations = Math.floor(utxoBalanceInKas - 1);
                                
                                console.log(`Processing regular UTXO with ${utxoBalanceInKas} KAS, requiring ${requiredIterations} iterations:`, currentUtxo.outpoint.transactionId);
                                
                                // Process this UTXO's iterations
                                for (let i = 0; i < requiredIterations; i++) {
                                    // Verify UTXO is still valid before each iteration
                                    const verifyUtxos = await this.rpc.getUtxosByAddresses([p2shAddress.toString()]);
                                    const isUtxoStillValid = verifyUtxos.entries?.some(utxo => 
                                        utxo.outpoint.transactionId === currentUtxo.outpoint.transactionId && 
                                        utxo.outpoint.index === currentUtxo.outpoint.index
                                    );

                                    if (!isUtxoStillValid) {
                                        console.log('UTXO no longer valid during iteration, will check for new UTXOs:', currentUtxo.outpoint.transactionId);
                                        break;
                                    }

                                    // Create reveal transaction
                                    const transactionParams = {
                                        priorityEntries: [currentUtxo],
                                        entries: [],
                                        outputs: [],
                                        changeAddress: p2shAddress.toString(),
                                        priorityFee: kaspaToSompi(gasFee),
                                        networkId: this.networkId
                                    };

                                    const { transactions: revealTransactions } = await createTransactions(transactionParams);
                                    let revealHash;

                                    for (const transaction of revealTransactions) {
                                        const ourOutput = transaction.transaction.inputs.findIndex((input) => input.signatureScript === '');
                                        const signature = await transaction.createInputSignature(ourOutput, privateKeyObj);
                                        const signatureScript = script.encodePayToScriptHashSignatureScript(signature);
                                        transaction.fillInput(ourOutput, signatureScript);
                                        revealHash = await transaction.submit(this.rpc);
                                        this.submittedTxId = revealHash;
                                    }

                                    await this.waitForTransaction(timeout);
                                    await new Promise(resolve => setTimeout(resolve, 100));

                                    results.push({
                                        iteration: iterationCount + i + 1,
                                        revealHash,
                                        type: 'reveal',
                                        remainingIterations: requiredIterations - (i + 1)
                                    });

                                    iterationCount++;
                                }

                                // If we successfully processed the UTXO, mark it as processed and reset failure counter
                                processedTxIds.add(currentUtxo.outpoint.transactionId);
                                consecutiveFailures = 0;

                            } catch (error) {
                                console.error('Error processing regular UTXO:', {
                                    error: error.message,
                                    utxo: currentUtxo.outpoint.transactionId
                                });
                                
                                consecutiveFailures++;
                                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                                    console.log(`Reached maximum consecutive failures (${MAX_CONSECUTIVE_FAILURES}), stopping processing`);
                                    keepProcessing = false;
                                    break;
                                }
                                
                                // Add a delay before trying the next UTXO
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                continue;
                            }
                        }

                        // Add delay between UTXO processing cycles
                        await new Promise(resolve => setTimeout(resolve, 500));

                    } catch (error) {
                        console.error('Error in UTXO processing cycle:', error);
                        consecutiveFailures++;
                        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                            console.log(`Reached maximum consecutive failures (${MAX_CONSECUTIVE_FAILURES}), stopping processing`);
                            keepProcessing = false;
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }

            // Process small UTXOs one at a time
            let keepProcessingSmall = true;
            while (keepProcessingSmall) {
                // Get current state of UTXOs
                const currentUtxos = await this.rpc.getUtxosByAddresses([p2shAddress.toString()]);
                if (!currentUtxos.entries || currentUtxos.entries.length === 0) {
                    console.log('No UTXOs remaining to process');
                    break;
                }

                // Filter for unprocessed small UTXOs
                const validSmallUtxos = currentUtxos.entries.filter(utxo => {
                    const amount = BigInt(utxo.amount);
                    return amount <= 200100000n && !processedTxIds.has(utxo.outpoint.transactionId);
                });

                if (validSmallUtxos.length === 0) {
                    console.log('No valid unprocessed small UTXOs remaining');
                    keepProcessingSmall = false;
                    break;
                }

                console.log('Processing small UTXOs:', validSmallUtxos.length);
                for (let currentUtxo of validSmallUtxos) {
                    try {
                        console.log('Processing small UTXO:', {
                            amount: currentUtxo.amount.toString(),
                            transactionId: currentUtxo.outpoint.transactionId
                        });

                        // First estimate the transaction fee
                        const estimateGenerator = new Generator({
                            priorityEntries: [currentUtxo],
                            entries: [],
                            outputs: [],
                            changeAddress: p2shAddress.toString(),
                            priorityFee: 0n,
                            networkId: this.networkId
                        });

                        const estimation = await estimateGenerator.estimate();
                        const transactionFee = estimation.fees || 0n;
                        console.log('Estimated transaction fee for small UTXO:', transactionFee.toString());

                        // Calculate priority fee as total amount minus transaction fee
                        const totalAmount = BigInt(currentUtxo.amount);
                        const availableForFee = totalAmount;
                        
                        if (availableForFee <= transactionFee) {
                            console.log('Insufficient funds for small UTXO transaction:', {
                                totalAmount: totalAmount.toString(),
                                transactionFee: transactionFee.toString(),
                            });
                            continue;
                        }

                        const priorityFee = availableForFee - transactionFee;
                        console.log('Calculated priority fee:', priorityFee.toString());

                        // Create transaction for this small UTXO
                        const transactionParams = {
                            priorityEntries: [currentUtxo],
                            entries: [],
                            outputs: [],
                            changeAddress: p2shAddress.toString(),
                            priorityFee: priorityFee,
                            networkId: this.networkId
                        };

                        console.log('Small UTXO transaction params:', {
                            ...transactionParams,
                            priorityFee: priorityFee.toString(),
                            totalAmount: totalAmount.toString(),
                            transactionFee: transactionFee.toString()
                        });

                        const { transactions } = await createTransactions(transactionParams);
                        
                        if (!transactions || transactions.length === 0) {
                            throw new Error('No transactions were created for small UTXO');
                        }

                        for (const transaction of transactions) {
                            const ourOutput = transaction.transaction.inputs.findIndex((input) => input.signatureScript === '');
                            if (ourOutput === -1) {
                                throw new Error('No empty signature script found in transaction inputs');
                            }

                            const signature = await transaction.createInputSignature(ourOutput, privateKeyObj);
                            const signatureScript = script.encodePayToScriptHashSignatureScript(signature);
                            transaction.fillInput(ourOutput, signatureScript);

                            // Log transaction details before submission
                            console.log('Small UTXO transaction details before submission:', {
                                inputCount: transaction.transaction.inputs.length,
                                outputCount: transaction.transaction.outputs.length,
                                signatureScriptSet: !!transaction.transaction.inputs[ourOutput].signatureScript,
                                priorityFee: priorityFee.toString(),
                                totalAmount: totalAmount.toString(),
                                transactionFee: transactionFee.toString()
                            });

                            const revealHash = await transaction.submit(this.rpc);
                            this.submittedTxId = revealHash;
                            processedTxIds.add(currentUtxo.outpoint.transactionId);

                            console.log('Small UTXO transaction submitted:', revealHash);
                            await this.waitForTransaction(timeout);
                            console.log('Small UTXO transaction confirmed');

                            results.push({
                                revealHash,
                                type: 'small_utxo_reveal',
                                utxo: {
                                    amount: currentUtxo.amount.toString(),
                                    transactionId: currentUtxo.outpoint.transactionId,
                                    priorityFee: priorityFee.toString(),
                                    transactionFee: transactionFee.toString()
                                }
                            });
                        }

                        // Add small delay between transactions
                        await new Promise(resolve => setTimeout(resolve, 100));

                    } catch (error) {
                        console.error('Error processing small UTXO:', {
                            error: error.message,
                            stack: error.stack,
                            utxo: {
                                amount: currentUtxo.amount.toString(),
                                transactionId: currentUtxo.outpoint.transactionId
                            }
                        });
                        // Continue with next UTXO even if this one fails
                        continue;
                    }
                }
            }

            // Final check for any remaining UTXOs
            const finalUtxos = await this.rpc.getUtxosByAddresses([p2shAddress.toString()]);
            if (!finalUtxos.entries || finalUtxos.entries.length === 0) {
                console.log('No UTXOs remaining, cleaning complete');
                const endTime = Date.now();
                return {
                    status: 'clean',
                    message: 'No UTXOs remaining',
                    sourceAddress: address.toString(),
                    p2shAddress: p2shAddress.toString(),
                    totalBalance: totalBalance.toString(),
                    duration: `${((endTime - startTime) / 1000).toFixed(2)}s`,
                    network: this.networkType === NetworkType.Testnet ? 'testnet-10' : 'mainnet'
                };
            }

            // Separate remaining UTXOs based on their balance
            const remainingRegularUtxos = [];
            const remainingSmallUtxos = [];
            
            finalUtxos.entries.forEach(utxo => {
                const utxoAmount = BigInt(utxo.amount);
                console.log('Checking remaining UTXO:', {
                    amount: utxoAmount.toString(),
                    transactionId: utxo.outpoint.transactionId
                });
                
                if (utxoAmount > 200100000n) {
                    console.log('UTXO with balance > 1.001 KAS, will process as regular:', utxo.outpoint.transactionId);
                    remainingRegularUtxos.push(utxo);
                } else {
                    console.log('UTXO with balance <= 1.001 KAS, will process in final batch:', utxo.outpoint.transactionId);
                    remainingSmallUtxos.push(utxo);
                }
            });

            // Process remaining regular UTXOs first
            if (remainingRegularUtxos.length > 0) {
                console.log(`Processing ${remainingRegularUtxos.length} remaining regular UTXOs`);
                for (const currentUtxo of remainingRegularUtxos) {
                    if (processedTxIds.has(currentUtxo.outpoint.transactionId)) {
                        console.log('UTXO already processed, skipping:', currentUtxo.outpoint.transactionId);
                        continue;
                    }

                    const utxoBalanceInKas = this.convertSompiToKas(currentUtxo.amount);
                    const requiredIterations = Math.floor(utxoBalanceInKas - 1);
                    
                    console.log(`Processing remaining regular UTXO with ${utxoBalanceInKas} KAS, requiring ${requiredIterations} iterations`);
                    
                    for (let i = 0; i < requiredIterations; i++) {
                        try {
                            // Verify UTXO is still valid
                            const currentUtxos = await this.rpc.getUtxosByAddresses([p2shAddress.toString()]);
                            const isUtxoStillValid = currentUtxos.entries?.some(utxo => 
                                utxo.outpoint.transactionId === currentUtxo.outpoint.transactionId && 
                                utxo.outpoint.index === currentUtxo.outpoint.index
                            );

                            if (!isUtxoStillValid) {
                                console.log('UTXO no longer valid, skipping:', currentUtxo.outpoint.transactionId);
                                break;
                            }

                            // Create reveal transaction
                            const transactionParams = {
                                priorityEntries: [currentUtxo],
                                entries: [],
                                outputs: [],
                                changeAddress: p2shAddress.toString(),
                                priorityFee: kaspaToSompi(gasFee),
                                networkId: this.networkId
                            };

                            const { transactions: revealTransactions } = await createTransactions(transactionParams);
                            let revealHash;

                            for (const transaction of revealTransactions) {
                                const ourOutput = transaction.transaction.inputs.findIndex((input) => input.signatureScript === '');
                                const signature = await transaction.createInputSignature(ourOutput, privateKeyObj);
                                const signatureScript = script.encodePayToScriptHashSignatureScript(signature);
                                transaction.fillInput(ourOutput, signatureScript);
                                revealHash = await transaction.submit(this.rpc);
                                this.submittedTxId = revealHash;
                            }

                            await this.waitForTransaction(timeout);
                            await new Promise(resolve => setTimeout(resolve, 100));

                            results.push({
                                iteration: iterationCount + i + 1,
                                revealHash,
                                type: 'reveal',
                                remainingIterations: requiredIterations - (i + 1)
                            });

                        } catch (error) {
                            console.error('Error processing remaining regular UTXO:', error);
                            throw error;
                        }
                    }
                    processedTxIds.add(currentUtxo.outpoint.transactionId);
                }
            }

            // Now handle any remaining small UTXOs as the final batch
            const finalSmallUtxos = await this.rpc.getUtxosByAddresses([p2shAddress.toString()]);
            const remainingValidUtxos = [];

            // Verify remaining UTXOs and filter out any that are too large
            for (const utxo of finalSmallUtxos.entries || []) {
                const utxoAmount = BigInt(utxo.amount);
                if (utxoAmount <= 200100000n) {
                    remainingValidUtxos.push(utxo);
                } else {
                    console.log('Skipping large UTXO in final batch:', utxo.outpoint.transactionId);
                }
            }

            if (remainingValidUtxos.length === 0) {
                console.log('No small UTXOs remaining for final transfer');
                const endTime = Date.now();
                return {
                    status: 'success',
                    sourceAddress: address.toString(),
                    totalIterations: iterationCount,
                    totalFees: this.convertSompiToKas(totalBalance.toString()),
                    duration: `${((endTime - startTime) / 1000).toFixed(2)}s`,
                    mintDetails: {
                        network: this.networkType === NetworkType.Testnet ? 'testnet-10' : 'mainnet'
                    }
                };
            }

            // Return with remaining balance info
            const remainingBalance = finalSmallUtxos.entries.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
            const endTime = Date.now();
            return {
                status: 'success',
                sourceAddress: address.toString(),
                totalIterations: iterationCount,
                totalFees: this.convertSompiToKas(totalBalance.toString()),
                duration: `${((endTime - startTime) / 1000).toFixed(2)}s`,
                mintDetails: {
                    network: this.networkType === NetworkType.Testnet ? 'testnet-10' : 'mainnet'
                }
            };

        } catch (error) {
            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(2);

            throw {
                error: error.message || error.error,
                failedAt: error.failedAt || {},
                duration: `${duration}s`
            };
        } finally {
            if (this.rpc) {
                await this.rpc.disconnect();
            }
        }
    }
}

module.exports = KaspaKrc20CleanerUtils; 