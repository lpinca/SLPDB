import { SlpTransactionDetails, SlpTransactionType, Slp, LocalValidator } from 'slpjs';
import BigNumber from "bignumber.js";
import { Bitcore, BitcoinRpc } from './vendor';
import BITBOXSDK from 'bitbox-sdk/lib/bitbox-sdk';
import { Config } from './config';

const RpcClient = require('bitcoin-rpc-promise')

const bitcore = require('bitcore-lib-cash');
var bitqueryd = require('fountainhead-bitqueryd')

export interface TokenGraph {
    tokenDetails: SlpTransactionDetails;
    tokenStats: TokenStats;
    _txnGraph: Map<txid, GraphTxn>;
    _addresses: Map<hash160, { token_balance_cramers: BigNumber, bch_balance_satoshis: BigNumber }>;
    updateTokenGraphFrom(txid: string): Promise<boolean>;
    computeStatistics(): Promise<boolean>;
}

export class SlpTokenGraph implements TokenGraph {
    tokenDetails: SlpTransactionDetails;    
    tokenStats!: TokenStats;
    tokenUtxos!: Set<string>;
    _txnGraph!: Map<string, GraphTxn>;
    _addresses!: Map<string, { token_balance_cramers: BigNumber; bch_balance_satoshis: BigNumber; }>;
    _slpValidator!: LocalValidator;
    rpcClient: BitcoinRpc.RpcClient;

    constructor(tokenDetails: SlpTransactionDetails) {
        if(tokenDetails.transactionType !== SlpTransactionType.GENESIS)
            throw Error("Cannot create a new token graph without providing GENESIS token details")
        this.tokenDetails = tokenDetails;
        this.tokenUtxos = new Set<string>();
        this._txnGraph = new Map<string, GraphTxn>();

        let connectionString = 'http://'+ Config.rpc.user+':'+Config.rpc.pass+'@'+Config.rpc.host+':'+Config.rpc.port
        this.rpcClient = <BitcoinRpc.RpcClient>(new RpcClient(connectionString));

        const BITBOX = new BITBOXSDK();
        this._slpValidator = new LocalValidator(BITBOX, async (txids) => [ await this.rpcClient.getRawTransaction(txids[0]) ])
    }

    async asyncForEach(array: any[], callback: Function) {
        for (let index = 0; index < array.length; index++) {
          await callback(array[index], index, array);
        }
    }

    async queryForTxoInput(txid: string, vout: number): Promise<TxnQueryResult|null> {
        let q = {
            "v": 3,
            "q": {
                "find": { 
                    "in": {
                        "$elemMatch": {
                            "e.h": txid,
                            "e.i": vout
                        }
                    }
                }   
            },
            "r": { "f": "[ .[] | { txid: .tx.h, block: (if .blk? then .blk.i else null end), timestamp: (if .blk? then (.blk.t | strftime(\"%Y-%m-%d %H:%M\")) else null end), tokenid: .out[0].h4, slp1: .out[0].h5, slp2: .out[0].h6, slp3: .out[0].h7, slp4: .out[0].h8, slp5: .out[0].h9, slp6: .out[0].h10, slp7: .out[0].h11, slp8: .out[0].h12, slp9: .out[0].h13, slp10: .out[0].h14, slp11: .out[0].h15, slp12: .out[0].h16, slp13: .out[0].h17, slp14: .out[0].h18, slp15: .out[0].h19, slp16: .out[0].h20, slp17: .out[0].h21, slp18: .out[0].h22, slp19: .out[0].h23, bch0: .out[0].e.v, bch1: .out[1].e.v, bch2: .out[2].e.v, bch3: .out[3].e.v, bch4: .out[4].e.v, bch5: .out[5].e.v, bch6: .out[6].e.v, bch7: .out[7].e.v, bch8: .out[8].e.v, bch9: .out[9].e.v, bch10: .out[10].e.v, bch11: .out[11].e.v, bch12: .out[12].e.v, bch13: .out[13].e.v, bch14: .out[14].e.v, bch15: .out[15].e.v, bch16: .out[16].e.v, bch17: .out[17].e.v, bch18: .out[18].e.v, bch19: .out[19].e.v } ]" }
        }

        //console.log(q)
        let db = await bitqueryd.init();
        let response: TxnQueryResponse = await db.read(q);
        
        if(!response.errors) {
            let results: TxnQueryResult[] = ([].concat(<any>response.c).concat(<any>response.u));
            //console.log("BitDB Response:", results);
            //results = results.filter(r => r.input.h === txid && r.input.i === vout)
            if(results.length === 1) {
                let res: any = results[0];
                let sendOutputs: { tokenQty: BigNumber, satoshis: number }[] = [];
                res.sendOutputs = sendOutputs;
                res.sendOutputs.push({ tokenQty: new BigNumber(0), satoshis: res.bch0 });
                let keys = Object.keys(res);
                keys.forEach((key, index) => {
                    if(res[key] && key.includes('slp')) {
                        try {
                            let qtyBuf = Buffer.from(res[key], 'hex');
                            res.sendOutputs.push({ tokenQty: (new BigNumber(qtyBuf.readUInt32BE(0).toString())).multipliedBy(2**32).plus(new BigNumber(qtyBuf.readUInt32BE(4).toString())), satoshis: res["bch" + key.replace('slp', '')] });
                        } catch(err) { 
                            console.log(err);
                            throw err;
                        }
                    }
                })
                //console.log("Bitdb Query Response = ", res)
                return res;
            }
            else {
                throw Error("Could not find the spend transaction: " + txid + ":" + vout);
            }
        }
        return null;
    }

    async getSpendDetails(txid: string, vout: number): Promise<SpendDetails> {
        let txOut = await this.rpcClient.getTxOut(txid, vout, false)
        //console.log('TXOUT', txOut);
        if(txOut === null) {
            let spendTxnInfo = await this.queryForTxoInput(txid, vout);
            console.log("SPENDTXNINFO:", spendTxnInfo);
            if(typeof spendTxnInfo!.txid === 'string') {
                this.tokenUtxos.delete(txid + ":" + vout)
                return { txid: spendTxnInfo!.txid, queryResponse: spendTxnInfo };
            }
        }
        console.log('TXID', txid);
        this.tokenUtxos.add(txid + ":" + vout);
        return { txid: null, queryResponse: null };
    }

    async updateTokenGraphFrom(txid: string): Promise<boolean> {
        if(this.tokenDetails.transactionType === SlpTransactionType.GENESIS)
            this._txnGraph.clear();
        
        let isValid = await this._slpValidator.isValidSlpTxid(txid)
        console.log("IS VALID:", txid, isValid);
        let graph: GraphTxn = { details: <SlpTransactionDetails>this._slpValidator.cachedValidations[txid].details, validSlp: isValid!, outputs: [] }
        let txn: Bitcore.Transaction = new bitcore.Transaction(this._slpValidator.cachedRawTransactions[txid])
        // Create SLP graph outputs for each valid SLP output
        if(isValid && graph.details.transactionType === SlpTransactionType.GENESIS) {
            if(graph.details.genesisOrMintQuantity!.isGreaterThan(0)) {
                let spendDetails = await this.getSpendDetails(txid, 1)
                graph.outputs.push({
                    vout: 1,
                    bchAmout: txn.outputs[1].satoshis, 
                    slpAmount: graph.details.genesisOrMintQuantity!,
                    spendTxid: spendDetails.txid
                })
                //console.log("GENESIS GRAPH OUTPUT: ", graph.outputs);
            }
        }
        else if(isValid && graph.details.sendOutputs!.length > 0) {
            await this.asyncForEach(graph.details.sendOutputs!, async (output: BigNumber, vout: number) => { 
                if(output.isGreaterThan(0)) {
                    let spendDetails = await this.getSpendDetails(txid, vout)
                    graph.outputs.push({
                        vout: vout,
                        bchAmout: txn.outputs[vout].satoshis, 
                        slpAmount: graph.details.sendOutputs![vout],
                        spendTxid: spendDetails.txid
                    })
                    //console.log("SEND GRAPH OUTPUT: ", graph.outputs);
                }
            })
        }
        else {
            throw Error("Transaction has not token outputs!")
        }

        this._txnGraph.set(txid, graph);

        // Recursively map out the outputs
        console.log("GRAPH OUTPUTS:", graph.outputs)
        await this.asyncForEach(graph.outputs.filter(o => o.spendTxid), async (o: any) => {
            console.log("UPDATE FROM: ", o.spendTxid!);
            await this.updateTokenGraphFrom(o.spendTxid!);
        })
        console.log("DONE:", graph.outputs)


        this._txnGraph.set(this.tokenDetails.tokenIdHex, graph);
        return true;
    }

    computeStatistics(): Promise<boolean> {
        throw new Error("Method not implemented.");
    }
}

interface GraphTxn {
    details: SlpTransactionDetails;
    validSlp: boolean;
    invalidReason?: string;
    outputs: { 
        vout: number, 
        bchAmout: number, 
        slpAmount: BigNumber, 
        spendTxid: string|null }[]
}

type txid = string;
type hash160 = string;

interface TokenStats {
    date_last_active_send: Date;
    date_last_active_mint: Date;
    qty_valid_txns_since_genesis: number;
    qty_utxos_holding_valid_tokens: number;
    qty_bch_holding_valid_tokens: number;
    qty_token_minted: BigNumber;
    qty_token_burned: BigNumber;
    qty_token_unburned: BigNumber;
}

interface SpendDetails {
    txid: string|null;
    queryResponse: TxnQueryResult|null;
}

interface TxnQueryResponse {
    c: TxnQueryResult[],
    u: TxnQueryResult[], 
    errors?: any;
}

interface TxnQueryResult {
    sendOutputs: { tokenQty: BigNumber, satoshis: number }[];
    //input: {h: string, i: number, a: string };
    txid: string;
    block: number|null;
    timestamp: string|null;
    bch0: number;
    bch1: number|null;
    bch2: number|null;
    bch3: number|null;
    bch4: number|null;
    bch5: number|null;
    bch6: number|null;
    bch7: number|null;
    bch8: number|null;
    bch9: number|null;
    bch10: number|null;
    bch11: number|null;
    bch12: number|null;
    bch13: number|null;
    bch14: number|null;
    bch15: number|null;
    bch16: number|null;
    bch17: number|null;
    bch18: number|null;
    bch19: number|null;
    slp0: number;
    slp1: number|null;
    slp2: number|null;
    slp3: number|null;
    slp4: number|null;
    slp5: number|null;
    slp6: number|null;
    slp7: number|null;
    slp8: number|null;
    slp9: number|null;
    slp10: number|null;
    slp11: number|null;
    slp12: number|null;
    slp13: number|null;
    slp14: number|null;
    slp15: number|null;
    slp16: number|null;
    slp17: number|null;
    slp18: number|null;
    slp19: number|null;
}

