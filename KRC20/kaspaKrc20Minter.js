// NOT USED ANYMORE







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
    createTransactions
} = kaspa;

const SOMPI_PER_KAS = 100000000n;

class KaspaKrc20Minter {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType === 'testnet-10' ? NetworkType.Testnet : NetworkType.Mainnet;
        this.rpc = null;
        this.eventReceived = false;
        this.submittedTxId = null;
        this.addedEventTxId = null;
        this.logFile = require('fs').createWriteStream('original_minting_transactions.log', { flags: 'a' });
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
        const kasAmount = sompiAmount / SOMPI_PER_KAS;
        return kasAmount.toString();
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

    setupUtxoListener(address) {
        this.rpc.addEventListener('utxos-changed', (event) => {
            console.log('UTXO changed event:', event);
            
            const removedEntry = event.data.removed.find((entry) => 
                entry.address.payload === address.split(':')[1]
            );
            const addedEntry = event.data.added.find((entry) => 
                entry.address.payload === address.split(':')[1]
            );    

            if (removedEntry) {
                console.log('Found removed UTXO for our address:', removedEntry);
                console.log('Found added UTXO for our address:', addedEntry);
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
                    resolve();
                }
            }, 500);
        });
    }

    async mintKrc20(fromPrivateKey, ticker, priorityFee = "0", iterations = 20) {
        try {
            await this.initialize();
            const gasFee = "1";
            const timeout = 30000;

            // Ensure minimum iterations
            const numIterations = Math.max(20, Number(iterations));
            console.log(`Will perform ${numIterations} mint iterations`);

            // Fetch the lim value from the API
            const amount = await this.fetchTokenLimits(ticker);
            console.log('Token limit per mint (sompi):', amount);
            const amountInKas = this.convertSompiToKas(amount);
            console.log('Token limit per mint (KAS):', amountInKas);

            // Calculate total amount to be minted
            const totalAmount = (BigInt(amount) * BigInt(numIterations)).toString();
            const totalAmountInKas = this.convertSompiToKas(totalAmount);
            console.log('Total amount to be minted (KAS):', totalAmountInKas);

            const privateKey = new PrivateKey(fromPrivateKey);
            const publicKey = privateKey.toPublicKey();
            const address = publicKey.toAddress(this.networkType);
            console.log('Source address:', address.toString());

            await this.rpc.subscribeUtxosChanged([address.toString()]);
            this.setupUtxoListener(address.toString());

            const results = [];
            for (let i = 0; i < numIterations; i++) {
                console.log(`Starting iteration ${i + 1} of ${numIterations}`);

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

                // Commit Transaction
                const { entries } = await this.rpc.getUtxosByAddresses([address.toString()]);
                
                this.logTransaction('commit_inputs', {
                    entries,
                    sourceAddress: address.toString()
                });

                const { transactions } = await createTransactions({
                    priorityEntries: [],
                    entries,
                    outputs: [{
                        address: P2SHAddress.toString(),
                        amount: kaspaToSompi(gasFee)
                    }],
                    changeAddress: address.toString(),
                    priorityFee: kaspaToSompi(priorityFee),
                    networkId: this.networkId
                });

                this.logTransaction('commit_transaction', {
                    outputs: [{
                        address: P2SHAddress.toString(),
                        amount: gasFee
                    }],
                    changeAddress: address.toString(),
                    priorityFee
                });

                let commitHash;
                for (const transaction of transactions) {
                    transaction.sign([privateKey]);
                    commitHash = await transaction.submit(this.rpc);
                    this.submittedTxId = commitHash;
                    console.log(`Commit transaction ${i + 1} submitted:`, commitHash);
                    this.logTransaction('commit_hash', {
                        iteration: i + 1,
                        hash: commitHash
                    });
                }

                await this.waitForTransaction(timeout);
                await new Promise(resolve => setTimeout(resolve, 100));

                // Reveal Transaction
                const { entries: newEntries } = await this.rpc.getUtxosByAddresses([address.toString()]);
                const revealUTXOs = await this.rpc.getUtxosByAddresses([P2SHAddress.toString()]);

                this.logTransaction('reveal_inputs', {
                    sourceEntries: newEntries,
                    p2shUtxos: revealUTXOs.entries
                });

                const { transactions: revealTransactions } = await createTransactions({
                    priorityEntries: [revealUTXOs.entries[0]],
                    entries: newEntries,
                    outputs: [],
                    changeAddress: address.toString(),
                    priorityFee: kaspaToSompi(gasFee),
                    networkId: this.networkId
                });

                this.logTransaction('reveal_transaction', {
                    priorityEntry: revealUTXOs.entries[0],
                    sourceEntries: newEntries,
                    changeAddress: address.toString(),
                    priorityFee: gasFee
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
                    this.logTransaction('reveal_hash', {
                        iteration: i + 1,
                        hash: revealHash
                    });
                }

                await this.waitForTransaction(timeout);

                results.push({
                    iteration: i + 1,
                    commitHash,
                    revealHash
                });

                if (i < numIterations - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }

            return {
                success: true,
                iterations: numIterations,
                transactions: results,
                mintSummary: {
                    amountPerMint: amountInKas,
                    totalAmount: totalAmountInKas,
                    totalIterations: numIterations
                }
            };

        } catch (error) {
            console.error('Error in mintKrc20:', error);
            this.logTransaction('error', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        } finally {
            if (this.rpc) {
                await this.rpc.disconnect();
            }
        }
    }
}

module.exports = KaspaKrc20Minter; 
