const logger = require("../../../config/winston");
var bitcoin = require("bitcoinjs-lib");
const rpc = require("./rpc");
const BigNumber = require("bignumber.js");
var request = require("axios");

var BITCOIN_DIGITS = 8;
var BITCOIN_SAT_MULT = Math.pow(10, BITCOIN_DIGITS);
const CONFIRM_COUNT = parseInt(process.env.BTC_CONFIRMATION_COUNT) + 1; // get num of blocks after current block!

var providers = {
  /**
   * Input: Address to retrieve the balance from.
   * Output: The balance in Satoshis.
   */
  balance: async function (addr) {
    if(process.env.BITCOIN_INSIGHT_SUPPORT === "Y") {
      return request.get(process.env.BTC_INSIGHT_URL + "/addr/" + addr + "/balance").then(function (res) {
        return parseFloat(res.data);
      });
    } else {
      const unspentList = await rpc.call("listunspent", [CONFIRM_COUNT, 999999, [addr]]);
      const total = unspentList.reduce((total, unspent) => new BigNumber(total).plus(unspent.amount).toNumber(), 0);
      return new BigNumber(total).times(BITCOIN_SAT_MULT).toNumber();
    }
  },
  /**
   * Input: Requested processing speed. "fastest", "halfHour" or "hour"
   * Output: Fee rate in Satoshi's per Byte.
   */
  fees: {
    earn: function (feeName) {
      return request.get("https://bitcoinfees.earn.com/api/v1/fees/recommended").then(function (res) {
        return res.data[feeName + "Fee"];
      });
    }
  },
  /**
   * Input: Sending user's BitCoin wallet address.
   * Output: List of utxo's to use. Must be in standard format. { txid, vout, satoshis, confirmations }
   */
  utxo: async function (addr) {
    let res = {};
    if(process.env.BITCOIN_INSIGHT_SUPPORT === "Y") {
      res = await request.get(process.env.BTC_INSIGHT_URL + "/addr/" + addr + "/utxo?noCache=1");
    } else {
      let unspent = await rpc.call("listunspent", [CONFIRM_COUNT, 999999, [addr]]);
      for(const u of unspent) u.satoshis = new BigNumber(u.amount).times(BITCOIN_SAT_MULT).toNumber();
      res.data = unspent;
    }
    return res.data.map(function (e) {
      return {
        txid: e.txid,
        vout: e.vout,
        satoshis: e.satoshis,
        confirmations: e.confirmations
      };
    });
  },
  /**
   * Input: A hex string transaction to be pushed to the blockchain.
   * Output: None
   */
  pushtx: function (hexTrans) {
    if(process.env.BITCOIN_INSIGHT_SUPPORT === "Y") {
      return request.post(process.env.BTC_INSIGHT_URL + "/tx/send", {
        rawtx: hexTrans
      });
    } else {
      return rpc.call("sendrawtransaction", [hexTrans]);
    }
  }
};

function getBalance(addr) {
  return providers.balance(addr).then(function (balSat) {
    return balSat / BITCOIN_SAT_MULT;
  });
}

function getTransactionSize(numInputs, numOutputs) {
  return numInputs * 180 + numOutputs * 34 + 10 + numInputs;
}

function getFees(provider, feeName) {
  if (typeof feeName === "number") {
    return Promise.resolve(feeName);
  } else {
    return provider(feeName);
  }
}

function sendTransaction(options) {
  //Required
  if (options == null || typeof options !== "object") throw new Error("Options must be specified and must be an object.");
  if (options.from == null) throw new Error("Must specify from address.");
  if (options.to == null) throw new Error("Must specify to address.");
  if (options.privKeyWIF == null) throw new Error("Must specify the wallet's private key in WIF format.");

  // set the default options
  if (options.dryrun == null) options.dryrun = false;
  if (options.minConfirmations == null) options.minConfirmations = 6;
  if (options.fee == null) options.fee = "fastest";

  options.feesProvider = providers.fees.earn;
  options.utxoProvider = providers.utxo;
  options.pushtxProvider = providers.pushtx;

  var from = options.from;
  var to, amount = 0;
  if (options.multi) {
    to = options.to;
    amount = options.to.reduce((total, addrAmt) => total + addrAmt.amount, 0);
  } else {
    if (options.allbalance) {
      to = [{
        address: options.to,
        rate: 1
      }];
    } else {
      to = [{
        address: options.to,
        amount: options.btc
      }];
    }
    amount = options.btc;
  }
  var bitcoinNetwork = options.network == "testnet" ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

  return Promise.all([
    getFees(options.feesProvider, options.fee),
    options.utxoProvider(from),
    getBalance(options.from)
  ]).then(function (res) {
    var feePerByte = res[0];
    var utxos = res[1];
    var bal = res[2];

    if (options.allbalance) {
      amount = bal;
    }

    var amtSatoshi = Math.floor(amount * BITCOIN_SAT_MULT);
    //Setup inputs from utxos
    var tx = new bitcoin.TransactionBuilder(bitcoinNetwork);
    var ninputs = 0;
    var availableSat = 0;
    var fee = 0;
    for (var i = 0; i < utxos.length; i++) {
      var utxo = utxos[i];
      if (utxo.confirmations >= options.minConfirmations) {
        tx.addInput(utxo.txid, utxo.vout);
        availableSat += utxo.satoshis;
        ninputs++;
        fee = getTransactionSize(ninputs, to.length) * feePerByte;
        if (availableSat >= (amtSatoshi + fee) && !options.allbalance) break;
      }
    }

    if ((availableSat - (amtSatoshi + fee)) > 0) {
      // get the fee if there's change
      fee = getTransactionSize(ninputs, to.length + 1) * feePerByte;
    }
    let change = availableSat - (amtSatoshi + fee);
    if (change < 0 && !options.allbalance) throw new Error("Not enough in wallet for fees");
    if (fee > amtSatoshi) logger.warn("BitCoin amount must be larger than the fee. (Ideally it should be MUCH larger)"); 

    if (options.allbalance) {
      amtSatoshi = amtSatoshi - fee;
    }

    for (let i = 0; i < to.length; i++) {
      if (options.allbalance) {
        tx.addOutput(to[i].address, Math.floor(amtSatoshi * to[i].rate));
      } else {
        tx.addOutput(to[i].address, Math.floor(to[i].amount * BITCOIN_SAT_MULT));
      }
    }

    if (change > 0) tx.addOutput(from, change);
    var keyPair = bitcoin.ECPair.fromWIF(options.privKeyWIF, bitcoinNetwork);
    for (let i = 0; i < ninputs; i++) {
      tx.sign(i, keyPair);
    }
    var msg = tx.build().toHex();
    if (options.dryrun) {
      return msg;
    } else {
      return options.pushtxProvider(msg);
    }
  });
}

module.exports = {
  providers: providers,
  getBalance: getBalance,
  sendTransaction: sendTransaction
};