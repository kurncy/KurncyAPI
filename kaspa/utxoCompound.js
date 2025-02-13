// NOT WORKING




globalThis.WebSocket = require('websocket').w3cwebsocket;

const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    Resolver, NetworkId,
    NetworkType, RpcClient,
    PrivateKey,
    kaspaToSompi,
    Encoding,
    createTransactions
} = kaspa;

class UtxoCompound {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType === 'testnet-10' ? NetworkType.Testnet : NetworkType.Mainnet;
        this.rpc = null;
        this.eventReceived = false;
        this.submittedTxId = null;
        this.addedEventTxId = null;
        this.currentWatchedAddress = null;
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

    setupUtxoListener(address) {
        this.rpc.addEventListener('utxos-changed', (event) => {
            console.log('UTXO changed event:', event);
            
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

    async compound(fromPrivateKey, priorityFee = "0.0001") {
        try {
            await this.initialize();
            const timeout = 30000;

            const privateKey = new PrivateKey(fromPrivateKey);
            const publicKey = privateKey.toPublicKey();
            const address = publicKey.toAddress(this.networkType);
            console.log('Source address:', address.toString());

            // Subscribe to address for UTXO changes
            await this.rpc.subscribeUtxosChanged([address.toString()]);
            this.setupUtxoListener(address.toString());
            this.currentWatchedAddress = address.toString();

            // Get all UTXOs
            const { entries } = await this.rpc.getUtxosByAddresses([address.toString()]);
            if (!entries || entries.length === 0) {
                throw new Error('No UTXOs found in source address');
            }

            // Log initial UTXO state
            console.log('Initial UTXOs:', {
                count: entries.length,
                utxos: entries.map(entry => ({
                    amount: entry.amount.toString(),
                    transactionId: entry.outpoint.transactionId,
                    index: entry.outpoint.index
                }))
            });

            console.log(`Processing ${entries.length} UTXOs in separate transactions`);

            let finalCompoundHash;
            let processedCount = 0;

            // Process each UTXO in a separate transaction
            for (const utxo of entries) {
                processedCount++;
                console.log(`Processing UTXO ${processedCount}/${entries.length}`);
                console.log('UTXO amount:', utxo.amount.toString());

                // Calculate output amount
                const outputAmount = BigInt(utxo.amount) - BigInt(kaspaToSompi(priorityFee));
                console.log('Output amount after fee:', outputAmount.toString());

                // Create compound transaction for this UTXO
                console.log('Creating compound transaction...');
                const { transactions } = await createTransactions({
                    priorityEntries: [utxo],
                    entries: [],
                    outputs: [{
                        address: address.toString(),
                        amount: outputAmount
                    }],
                    changeAddress: address.toString(),
                    priorityFee: kaspaToSompi("0"),
                    networkId: this.networkId
                });

                // Submit compound transaction
                for (const transaction of transactions) {
                    transaction.sign([privateKey]);
                    finalCompoundHash = await transaction.submit(this.rpc);
                    this.submittedTxId = finalCompoundHash;
                    console.log(`Transaction ${processedCount} submitted:`, finalCompoundHash);
                }

                // Wait for compound transaction to be processed
                await this.waitForTransaction(timeout);
                console.log(`Transaction ${processedCount} confirmed`);

                // Wait a bit before processing the next UTXO
                if (processedCount < entries.length) {
                    console.log('Waiting before processing next UTXO...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            // Get final UTXO state
            const { entries: finalEntries } = await this.rpc.getUtxosByAddresses([address.toString()]);

            // Log final state
            console.log('Final UTXOs:', {
                count: finalEntries.length,
                utxos: finalEntries.map(entry => ({
                    amount: entry.amount.toString(),
                    transactionId: entry.outpoint.transactionId,
                    index: entry.outpoint.index
                }))
            });

            return {
                success: true,
                sourceAddress: address.toString(),
                initialUtxoCount: entries.length,
                finalUtxoCount: finalEntries.length,
                processedUtxos: processedCount,
                finalTransactionHash: finalCompoundHash
            };

        } catch (error) {
            console.error('Error in compound operation:', error);
            throw error;
        } finally {
            if (this.rpc) {
                await this.rpc.disconnect();
            }
        }
    }
}

module.exports = UtxoCompound; 