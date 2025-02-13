// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const fetch = require('node-fetch');
const {
    Resolver, NetworkId,
    NetworkType, RpcClient,
    ScriptBuilder, Opcodes,
    PrivateKey,
    addressFromScriptPublicKey,
    kaspaToSompi,
    Encoding,
    createTransactions,
    Generator
} = kaspa;

const SOMPI_PER_KAS = 100000000n;

class KaspaKrc20MinterUtils {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType === 'testnet-10' ? NetworkType.Testnet : NetworkType.Mainnet;
        this.rpc = null;
        this.eventReceived = false;
        this.submittedTxId = null;
        this.addedEventTxId = null;
        this.currentWatchedAddress = null;
        this.logFile = require('fs').createWriteStream('minting_transactions.log', { flags: 'a' });
    }

    logTransaction(type, data) {
        const timestamp = new Date().toISOString();
        // Convert BigInt to string in the data object
        const processData = (obj) => {
            const newObj = {};
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'bigint') {
                    newObj[key] = value.toString();
                } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                    newObj[key] = processData(value);
                } else if (Array.isArray(value)) {
                    newObj[key] = value.map(item => 
                        typeof item === 'bigint' ? item.toString() : 
                        (item && typeof item === 'object' ? processData(item) : item)
                    );
                } else {
                    newObj[key] = value;
                }
            }
            return newObj;
        };

        const processedData = processData(data);
        const logEntry = `\n[${timestamp}] ${type.toUpperCase()} TRANSACTION\n${JSON.stringify(processedData, null, 2)}\n`;
        this.logFile.write(logEntry);
        console.log(logEntry);
    }

    convertSompiToKas(sompi) {
        const sompiAmount = BigInt(sompi);
        const kasAmount = Number(sompiAmount) / Number(SOMPI_PER_KAS);
        return kasAmount.toFixed(6);  // Always show 6 decimal places
    }

    async initialize() {
        console.log('Initializing RPC client...');
        this.rpc = new RpcClient({
            resolver: new Resolver(),
            encoding: Encoding.Borsh,
            networkId: this.networkId
        });
        await this.rpc.connect();
        console.log('RPC client connected');
    }

    async fetchTokenLimits(ticker) {
        try {
            const response = await fetch(`https://tn10api.kasplex.org/v1/krc20/token/${ticker}`, {
                method: 'GET',
                headers: {}
            });
            const data = await response.json();
            
            if (!data.result || !data.result[0] || !data.result[0].lim) {
                throw new Error('Could not fetch token limits');
            }
            
            return data.result[0].lim;
        } catch (error) {
            console.error('Error fetching token limits:', error);
            throw error;
        }
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
                // For initial reveal, we only need to check for removal
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

    async mintKrc20(fromPrivateKey, ticker, priorityFee = "0", iterations = 20) {
        const startTime = Date.now();
        try {
            await this.initialize();
            const gasFee = "1";
            const timeout = 30000;

            // Ensure minimum iterations
            const numIterations = Math.max(20, Number(iterations));
            console.log(`Will perform ${numIterations} mint iterations`);

            // Calculate commit amount based on iterations
            const commitAmount = (numIterations).toString();
            console.log('Commit amount:', commitAmount);

            const privateKey = new PrivateKey(fromPrivateKey);
            const publicKey = privateKey.toPublicKey();
            const address = publicKey.toAddress(this.networkType);
            console.log('Source address:', address.toString());

            // Create P2SH script and address outside the loop since it's constant
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

            const P2SHAddress = addressFromScriptPublicKey(script.createPayToScriptHashScript(), this.networkType);
            console.log('P2SH address:', P2SHAddress.toString());

            // Subscribe to both addresses
            await this.rpc.subscribeUtxosChanged([address.toString(), P2SHAddress.toString()]);
            this.setupUtxoListener(address.toString(), P2SHAddress.toString());

            // Initial commit transaction to P2SH address
            console.log('Performing initial commit transaction...');
            this.currentWatchedAddress = address.toString();

            const { entries } = await this.rpc.getUtxosByAddresses([address.toString()]);
            if (!entries || entries.length === 0) {
                throw new Error('No UTXOs found in source address');
            }

            // Log all available UTXOs for debugging
            console.log('Available UTXOs:');
            entries.forEach((entry, i) => {
                console.log(`UTXO ${i}:`, {
                    index: entry.outpoint.index,
                    amount: entry.amount.toString(),
                    transactionId: entry.outpoint.transactionId
                });
            });

            // Log initial UTXOs
            this.logTransaction('initial_utxos', {
                utxos: entries.map(entry => ({
                    index: entry.outpoint.index,
                    amount: entry.amount.toString(),
                    transactionId: entry.outpoint.transactionId
                }))
            });

            const sourceUtxo = entries[0];
            this.logTransaction('selected_utxo', {
                index: sourceUtxo.outpoint.index,
                amount: sourceUtxo.amount.toString(),
                transactionId: sourceUtxo.outpoint.transactionId
            });

            // Estimate transaction fee for one transaction
            console.log('Estimating transaction fee...');
            const initialEstimateGenerator = new Generator({
                priorityEntries: [sourceUtxo],
                entries: [],
                outputs: [],
                changeAddress: address.toString(),
                priorityFee: 0n,
                networkId: this.networkId
            });

            const initialEstimation = await initialEstimateGenerator.estimate();
            const initialTransactionFee = initialEstimation.fees || 0n;

            // Calculate total fees for all iterations
            const totalFees = initialTransactionFee * BigInt(numIterations);
            console.log('Total fees for all iterations:', totalFees.toString());

            // Add fees to commit amount
            const commitAmountInSompi = kaspaToSompi(commitAmount);
            const additionalAmount = kaspaToSompi("0.0001"); // Add 0.0001 KAS
            const totalCommitAmount = BigInt(commitAmountInSompi) + totalFees + BigInt(additionalAmount);
            console.log('Total commit amount including fees and additional amount:', totalCommitAmount.toString());

            this.logTransaction('fee_estimation', {
                estimatedFee: initialTransactionFee.toString(),
                totalFees: totalFees.toString(),
                commitAmount: commitAmountInSompi,
                totalCommitAmount: totalCommitAmount.toString(),
                estimationDetails: {
                    mass: initialEstimation.mass ? initialEstimation.mass.toString() : "0",
                    size: initialEstimation.size || 0,
                    iterations: numIterations,
                    sourceUtxo: {
                        index: sourceUtxo.outpoint.index,
                        amount: sourceUtxo.amount.toString(),
                        transactionId: sourceUtxo.outpoint.transactionId
                    }
                }
            });

            // Initial commit transaction
            let initialCommitHash;  // Declare outside try block
            try {
                const { transactions } = await createTransactions({
                    priorityEntries: [sourceUtxo],
                    entries: [],
                    outputs: [{
                        address: P2SHAddress.toString(),
                        amount: totalCommitAmount
                    }],
                    changeAddress: address.toString(),
                    priorityFee: kaspaToSompi(priorityFee),
                    networkId: this.networkId
                });

                for (const transaction of transactions) {
                    transaction.sign([privateKey]);
                    initialCommitHash = await transaction.submit(this.rpc);
                    this.submittedTxId = initialCommitHash;
                }

                await this.waitForTransaction(timeout);
            } catch (error) {
                const totalFeesInSompi = BigInt(totalCommitAmount) + BigInt(initialTransactionFee) - BigInt(commitAmountInSompi);
                throw {
                    error: error.message,
                    failedAt: {
                        phase: 'initial_commit',
                        totalIterationsAttempted: 0,
                        plannedIterations: numIterations,
                        fees: {
                            totalFeesSpent: this.convertSompiToKas(totalFeesInSompi.toString())
                        }
                    }
                };
            }

            this.logTransaction('commit_transaction_confirmed', {
                hash: initialCommitHash
            });

            // Perform reveal for source address to get index 0
            console.log('Performing source address reveal...');
            const sourceAddressUtxos = await this.rpc.getUtxosByAddresses([address.toString()]);
            if (!sourceAddressUtxos.entries || sourceAddressUtxos.entries.length === 0) {
                throw new Error('No UTXOs found in source address after commit');
            }

            const sourceRevealUtxo = sourceAddressUtxos.entries[0];
            const { transactions: sourceRevealTransactions } = await createTransactions({
                priorityEntries: [sourceRevealUtxo],
                entries: [],
                outputs: [],
                changeAddress: address.toString(),
                priorityFee: kaspaToSompi(priorityFee),
                networkId: this.networkId
            });

            let sourceRevealHash;
            for (const transaction of sourceRevealTransactions) {
                transaction.sign([privateKey]);
                sourceRevealHash = await transaction.submit(this.rpc);
                console.log('Source address reveal transaction submitted:', sourceRevealHash);
            }

            // Wait for source reveal to be processed
            await this.waitForTransaction(timeout);
            await new Promise(resolve => setTimeout(resolve, 100));

            // Now proceed with P2SH operations
            this.currentWatchedAddress = P2SHAddress.toString();
            const p2shUtxos = await this.rpc.getUtxosByAddresses([P2SHAddress.toString()]);
            if (!p2shUtxos.entries || p2shUtxos.entries.length === 0) {
                throw new Error('No UTXO found in P2SH address after commit');
            }
            let p2shUtxo = p2shUtxos.entries[0];

            const results = [];
            results.push({
                iteration: 0,
                commitHash: initialCommitHash,
                type: 'initial_commit'
            });
            results.push({
                iteration: 0,
                revealHash: sourceRevealHash,
                type: 'source_reveal'
            });

            // Perform reveal transactions for n-1 iterations
            const actualIterations = numIterations - 1;
            for (let i = 0; i < actualIterations; i++) {
                try {
                    console.log(`Starting iteration ${i + 1} of ${actualIterations}`);

                    this.logTransaction('iteration_reveal_input', {
                        iteration: i + 1,
                        p2shUtxo
                    });

                    // Reveal transaction
                    console.log(`Starting reveal transaction ${i + 1}`);
                    const { transactions: revealTransactions } = await createTransactions({
                        priorityEntries: [p2shUtxo],
                        entries: [],
                        outputs: [],
                        changeAddress: P2SHAddress.toString(),
                        priorityFee: kaspaToSompi(gasFee),
                        networkId: this.networkId
                    });

                    let revealHash;
                    for (const transaction of revealTransactions) {
                        transaction.sign([privateKey], false);
                        const ourOutput = transaction.transaction.inputs.findIndex((input) => input.signatureScript === '');

                        if (ourOutput !== -1) {
                            const signature = await transaction.createInputSignature(ourOutput, privateKey);
                            transaction.fillInput(ourOutput, script.encodePayToScriptHashSignatureScript(signature));
                        }

                        revealHash = await transaction.submit(this.rpc);
                        this.submittedTxId = revealHash;
                        console.log(`Reveal transaction ${i + 1} submitted:`, revealHash);
                    }

                    await this.waitForTransaction(timeout);
                    // Add 100ms delay after each iteration
                    await new Promise(resolve => setTimeout(resolve, 100));

                    results.push({
                        iteration: i + 1,
                        revealHash,
                        type: 'reveal'
                    });

                    if (i < actualIterations - 1) {
                        const newP2shUtxos = await this.rpc.getUtxosByAddresses([P2SHAddress.toString()]);
                        if (!newP2shUtxos.entries || newP2shUtxos.entries.length === 0) {
                            throw new Error(`No UTXO found in P2SH address after reveal ${i + 1}`);
                        }
                        p2shUtxo = newP2shUtxos.entries[0];
                    }
                } catch (error) {
                    // Calculate fees up to this point
                    const totalFeesInSompi = BigInt(totalCommitAmount) + BigInt(initialTransactionFee) - BigInt(commitAmountInSompi);
                    
                    throw {
                        error: error.message,
                        failedAt: {
                            iteration: i + 1,
                            totalIterationsAttempted: i + 1,
                            plannedIterations: numIterations,
                            fees: {
                                totalFeesSpent: this.convertSompiToKas(totalFeesInSompi.toString())
                            }
                        }
                    };
                }
            }

            // Handle the final iteration differently
            console.log('Performing final transfer iteration');
            const finalUtxos = await this.rpc.getUtxosByAddresses([P2SHAddress.toString()]);
            if (!finalUtxos.entries || finalUtxos.entries.length === 0) {
                throw new Error('No UTXOs found for final transfer');
            }

            // Calculate total balance from current UTXOs
            const totalBalance = finalUtxos.entries.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
            console.log('Total balance for final transfer:', totalBalance.toString());

            // Estimate the transaction fee first
            const finalEstimateGenerator = new Generator({
                priorityEntries: finalUtxos.entries,
                entries: [],
                outputs: [],
                changeAddress: P2SHAddress.toString(),
                priorityFee: 0n,
                networkId: this.networkId
            });

            const finalEstimation = await finalEstimateGenerator.estimate();
            const finalTransactionFee = finalEstimation.fees || 0n;
            console.log('Estimated transaction fee:', finalTransactionFee.toString());

            // Calculate priority fee as total balance minus transaction fee
            const finalPriorityFee = totalBalance - finalTransactionFee;
            console.log('Final priority fee:', finalPriorityFee.toString());

            // Final reveal transaction
            try {
                console.log('Creating final transactions...');
                const { transactions: finalTransactions } = await createTransactions({
                    priorityEntries: finalUtxos.entries,
                    entries: [],
                    outputs: [],
                    changeAddress: P2SHAddress.toString(),
                    priorityFee: finalPriorityFee,
                    networkId: this.networkId
                });

                if (!finalTransactions || finalTransactions.length === 0) {
                    throw new Error('No final transactions were created');
                }

                console.log(`Processing ${finalTransactions.length} final transactions...`);
                let finalHash;

                for (let i = 0; i < finalTransactions.length; i++) {
                    const transaction = finalTransactions[i];
                    console.log(`Processing final transaction ${i + 1}/${finalTransactions.length}`);

                    try {
                        // Sign the transaction
                        console.log('Signing transaction...');
                        transaction.sign([privateKey], false);
                        
                        // Find and process the output
                        const ourOutput = transaction.transaction.inputs.findIndex((input) => input.signatureScript === '');
                        console.log('Found output index for signing:', ourOutput);

                        if (ourOutput === -1) {
                            throw new Error('No empty signature script found in transaction inputs');
                        }

                        // Create and fill the signature
                        console.log('Creating signature for output:', ourOutput);
                        const signature = await transaction.createInputSignature(ourOutput, privateKey);
                        if (!signature) {
                            throw new Error('Failed to create input signature');
                        }

                        transaction.fillInput(ourOutput, script.encodePayToScriptHashSignatureScript(signature));

                        // Submit the transaction
                        console.log('Submitting transaction...');
                        const submittedHash = await transaction.submit(this.rpc);
                        
                        if (!submittedHash) {
                            throw new Error('Transaction submission returned empty hash');
                        }
                        
                        console.log('Transaction submitted successfully with hash:', submittedHash);
                        finalHash = submittedHash;
                        this.submittedTxId = finalHash;

                        // Log the successful transaction
                        this.logTransaction('final_transaction_submitted', {
                            transactionIndex: i + 1,
                            totalTransactions: finalTransactions.length,
                            hash: finalHash
                        });
                    } catch (txError) {
                        console.error('Error in final transaction processing:', txError);
                        this.logTransaction('final_transaction_error', {
                            transactionIndex: i + 1,
                            totalTransactions: finalTransactions.length,
                            error: txError.message
                        });
                        throw new Error(`Final transaction ${i + 1} failed: ${txError.message}`);
                    }
                }

                if (!finalHash) {
                    throw new Error('Final transaction hash was not set after processing all transactions');
                }

                console.log('All final transactions processed successfully');
                console.log('Waiting for final transaction confirmation...');
                
                try {
                    await this.waitForTransaction(timeout);
                    console.log('Final transaction confirmed');
                } catch (confirmError) {
                    throw new Error(`Transaction confirmation failed: ${confirmError.message}`);
                }

                results.push({
                    iteration: numIterations,
                    revealHash: finalHash,
                    type: 'final_transfer'
                });

                // Calculate total fees
                console.log('Raw values before fee calculation:', {
                    initialTransactionFee: typeof initialTransactionFee, 
                    initialTransactionFeeValue: initialTransactionFee.toString(),
                    totalCommitAmount: typeof totalCommitAmount,
                    totalCommitAmountValue: totalCommitAmount.toString(),
                    commitAmountInSompi: typeof commitAmountInSompi,
                    commitAmountInSompiValue: commitAmountInSompi.toString()
                });

                const totalFeesInSompi = BigInt(totalCommitAmount) + BigInt(initialTransactionFee) - BigInt(commitAmountInSompi);
                console.log('Fee calculation components:', {
                    totalCommitAmount: totalCommitAmount.toString(),
                    initialTransactionFee: initialTransactionFee.toString(),
                    commitAmount: commitAmountInSompi.toString(),
                    calculatedTotalFees: totalFeesInSompi.toString(),
                    calculatedTotalFeesInKas: this.convertSompiToKas(totalFeesInSompi.toString())
                });

                // For successful completion
                const endTime = Date.now();
                const duration = ((endTime - startTime) / 1000).toFixed(2); // Convert to seconds with 2 decimal places

                return {
                    sourceAddress: address.toString(),
                    totalIterations: numIterations,
                    totalFees: this.convertSompiToKas(totalFeesInSompi.toString()),
                    totalAmountMinted: this.convertSompiToKas((BigInt(await this.fetchTokenLimits(ticker)) * BigInt(numIterations)).toString()),
                    duration: `${duration}s`
                };

            } catch (error) {
                const totalFeesInSompi = BigInt(totalCommitAmount) + BigInt(initialTransactionFee) - BigInt(commitAmountInSompi);
                throw {
                    error: error.message,
                    failedAt: {
                        phase: 'final_reveal',
                        totalIterationsAttempted: numIterations - 1,
                        plannedIterations: numIterations,
                        fees: {
                            totalFeesSpent: this.convertSompiToKas(totalFeesInSompi.toString())
                        }
                    }
                };
            }

        } catch (error) {
            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(2);

            // For initial commit error
            if (error.failedAt && error.failedAt.phase === 'initial_commit') {
                throw {
                    error: error.error,
                    failedAt: {
                        ...error.failedAt,
                        duration: `${duration}s`
                    }
                };
            }

            // For iteration error
            if (error.failedAt && error.failedAt.iteration) {
                throw {
                    error: error.error,
                    failedAt: {
                        ...error.failedAt,
                        duration: `${duration}s`
                    }
                };
            }

            // For final reveal error
            if (error.failedAt && error.failedAt.phase === 'final_reveal') {
                throw {
                    error: error.error,
                    failedAt: {
                        ...error.failedAt,
                        duration: `${duration}s`
                    }
                };
            }

            // For any other errors
            throw {
                error: error.message,
                duration: `${duration}s`
            };
        } finally {
            if (this.rpc) {
                await this.rpc.disconnect();
            }
        }
    }
}

module.exports = KaspaKrc20MinterUtils; 