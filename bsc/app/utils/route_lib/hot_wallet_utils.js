const Web3 = require("web3");
const BigNumber = require("bignumber.js");

const baseUtil = require("../base_utils");
const amtUtil = require("../amt_utils");
const ethUtil = require("../eth_utils");
const btcUtil = require("../btc_utils");
const omniUtil = require("../omni_utils");
const tronUtil = require("../tron_utils");
const filUtil = require("../fil_utils");

module.exports = {
  AMT: async(wallet) => {
    const amtHotWallet = process.env.AMT_HOT_WALLET;
    const asset = baseUtil.getValueMem("asset");
    let balances = await amtUtil.getBalance(amtHotWallet, false);
    let amtBalance = 0, assetBal = 0;
    for (const bal of balances) {
      if (bal.assetref === "") {
        amtBalance = bal.qty;
      }
      if (bal.assetref === asset.assetref) {
        assetBal = bal.qty;
      }
    }
    wallet.amt = {
      address: amtHotWallet,
      amt: amtBalance,
      amt_a: assetBal
    };
  },
  ETH: async(wallet) => {
    const web3 = new Web3(ethUtil.WEB3_PROVIDER);
    const ethHotWallet = process.env.ETH_HOT_WALLET;
    let weiResult = await ethUtil.getBalance(web3, ethHotWallet);
    let ethBalance = BigNumber(web3.fromWei(weiResult, "ether"));
    let amtcBalance = await ethUtil.getTokenBalance(web3, ethHotWallet);
    let walletLink = process.env.ETH_WALLET_BASE_URL + ethHotWallet;
    wallet.eth = {
      address: ethHotWallet,
      eth: ethBalance,
      amtc: amtcBalance,
      walletLink
    };
  },
  BTC: async(wallet) => {
    const btcHotWallet = process.env.BTC_HOT_WALLET;
    const btcBalance = await btcUtil.getBalance(btcHotWallet);
    let omniBalance = 0;
    if (process.env.BTC_OMNI_SUPPORT === "Y") {
      omniBalance = new BigNumber((await omniUtil.getBalance(btcHotWallet)).balance).toNumber();
    }
    wallet.btc = {
      address: btcHotWallet,
      btc: btcBalance,
      omni: omniBalance
    };
  },
  TRX: async(wallet) => {
    const trxHotWallet = process.env.TRX_HOT_WALLET;
    const trxBalance = await tronUtil.getBalance(trxHotWallet);
    const trcBalance = await tronUtil.getTokenBalance(trxHotWallet);
    wallet.trx = {
      address: trxHotWallet,
      trx: trxBalance,
      trc20: trcBalance
    };
  },
  FIL: async(wallet) => {
    const filHotWallet = process.env.FIL_HOT_WALLET;
    const filBalance = await filUtil.getBalance(filHotWallet);
    wallet.fil = {
      address: filHotWallet,
      fil: filBalance
    };
  },
};