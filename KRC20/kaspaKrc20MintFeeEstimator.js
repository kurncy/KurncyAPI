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

class KaspaKrc20MintFeeEstimator {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType === 'testnet-10' ? NetworkType.Testnet : NetworkType.Mainnet;
        this.rpc = null;
    }

    convertSompiToKas(sompi) {
        const sompiAmount = BigInt(sompi);
        const kasAmount = Number(sompiAmount) / Number(SOMPI_PER_KAS);
        return kasAmount.toFixed(6);
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

    async estimateMintFees(fromPrivateKey, ticker, iterations = 20) {
        try {
            await this.initialize();
            const gasFee = "0";
            const numIterations = Math.max(20, Number(iterations)) + 2;

            const privateKey = new PrivateKey(fromPrivateKey);
            const publicKey = privateKey.toPublicKey();
            const address = publicKey.toAddress(this.networkType);

            // Create sample mint data
            const data = { 
                p: "krc-20", 
                op: "mint", 
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

            // Get UTXOs for fee estimation
            const { entries } = await this.rpc.getUtxosByAddresses([address.toString()]);

            if (!entries || entries.length === 0) {
                throw new Error('No UTXOs found for the address');
            }

            console.log('Found UTXOs:', entries.length);

            try {
                // Use smallest UTXO for estimation
                const sortedEntries = entries.sort((a, b) => BigInt(a.utxoEntry.amount) - BigInt(b.utxoEntry.amount));
                const sourceUtxo = sortedEntries[0];

                // Create a generator for mass estimation
                console.log('Estimating transaction mass...');
                const generator = new Generator({
                    priorityEntries: [sourceUtxo],
                    entries: [],
                    outputs: [],
                    changeAddress: address.toString(),
                    priorityFee: 0n,
                    networkId: this.networkId
                });

                // Get transaction estimation first
                const estimation = await generator.estimate();
                const mass = estimation.mass;
                console.log('Transaction mass:', mass);
                
                // Calculate fee per iteration in sompi (1 sompi per mass unit)
                const feePerIterationSompi = BigInt(mass);
                const feePerIterationKas = this.convertSompiToKas(feePerIterationSompi.toString());
                console.log('Fee per iteration:', feePerIterationKas, 'KAS');

                // Calculate total fees for all iterations
                const totalFeesSompi = feePerIterationSompi * BigInt(numIterations);
                const totalFeesKas = this.convertSompiToKas(totalFeesSompi.toString());
                console.log('Total fees:', totalFeesKas, 'KAS');

                return {
                    success: true,
                    estimatedFees: {
                        feePerIteration: feePerIterationKas,
                        totalFees: totalFeesKas,
                        iterations: numIterations,
                        breakdown: {
                            mass: mass.toString(),
                            feePerIterationSompi: feePerIterationSompi.toString(),
                            totalFeesSompi: totalFeesSompi.toString()
                        }
                    }
                };
            } catch (txError) {
                console.error('Transaction creation error:', txError);
                if (txError.message) {
                    throw new Error(`Failed to estimate fees: ${txError.message}`);
                } else {
                    throw new Error('Failed to estimate fees: Unable to create test transactions');
                }
            }
        } catch (error) {
            console.error('Error estimating mint fees:', error);
            throw error;
        } finally {
            if (this.rpc) {
                await this.rpc.disconnect();
            }
        }
    }
}

module.exports = KaspaKrc20MintFeeEstimator; 