// Sep 8 2020 (danie) - added file
// Sep 14 2020 (danie) - added retrieval of account 
// Oct 15 2020 (danie) - modified retrieval to use tokenview and events per block
// Oct 28 2020 (danie) - removed creation of tronweb if TRX is not supported
const axios = require("axios");
const BigNumber = require("bignumber.js");
const logger = require("../../../config/winston");
const TronWeb = require("tronweb");

let tronWeb;
if(process.env.CHAIN_SUPPORT.includes("TRX")) {
  tronWeb = new TronWeb({fullHost: process.env.TRX_TRONGRID_API_URL});
}

const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const blockApiRetrieval = (blockNum) => {
  let apiUse = "tronscan";
  if(process.env.TRX_USE_TOKENVIEW === "Y") {
    apiUse = new BigNumber(blockNum).mod(2).toNumber() === 0 ? "tronscan" : "tokenview";
  }
  return apiUse;
};

const getBlock = async (blockNum) => {
  let result=[];
  let apiUse = blockApiRetrieval(blockNum);
  if(apiUse === "tronscan") {
    logger.debug(`scan.getBlock - retrieving transaction from tronscan ${blockNum}`);
    let data = await axios.get(process.env.TRX_TRONSCAN_API_URL + "/transaction?count=true&limit=50&start=0&total=0&block=" + blockNum);
    result =result.concat(data.data.data);
    while (result.length < data.data.total){
      await sleep(500);
      data =  await axios.get(process.env.TRX_TRONSCAN_API_URL + "/transaction?count=true&limit=50&start="+result.length+"&total="+data.data.total+"&block=" + blockNum);
      result =result.concat(data.data.data);
    }
    let res = await axios.get(`${process.env.TRX_TRONGRID_API_URL}/v1/blocks/${blockNum}/events`);
    let eventRes = res.data.data;
    while(res.data.meta.links) {
      await sleep(300);
      let nextUrl = res.data.meta.links.next;
      if(nextUrl.search(process.env.TRX_TRONGRID_API_URL) === -1) {
        nextUrl = process.env.TRX_TRONGRID_API_URL + nextUrl;
      }
      res = await axios.get(nextUrl);
      //res = await axios.get(res.data.meta.links.next);
      eventRes = eventRes.concat(res.data.data);
    }
    const events = eventRes.reduce((mapped, ev) => {
      if(!mapped[ev.transaction_id]) {
        mapped[ev.transaction_id] = [];
      }
      if(ev.event_name === "Transfer") {
        mapped[ev.transaction_id].push({
          from: tronWeb.address.fromHex(ev.result.from),
          to: tronWeb.address.fromHex(ev.result.to),
          value: ev.result.value || ev.result.tokens,
        });
      }
      return mapped;
    }, {});
    for (const r of result) {
      r.tokenTransfer = events[r.hash];
    }
  } else {
    let page = 1, count = 50;
    let resp = await axios.get(`https://trx.tokenview.com/api/tx/trx/${blockNum}/${page}/${count}`);
    let data = resp.data;
    result = result.concat(data.data);
    logger.debug(`scan.getBlock - retrieving transaction from tokenview ${blockNum} first code: ${data.code}`);
    if(data.code === 404 && data.msg === "无数据") {
      return [];
    } else if(data.code !== 1) {
      throw new Error("Unable to retrieve data for block " + blockNum);
    }
    while (data.data.length === 50){
      page++;
      await sleep(300);
      resp =  await axios.get(`https://trx.tokenview.com/api/tx/trx/${blockNum}/${page}/${count}`);
      data = resp.data;
      if(!data.data) {
        logger.debug(`scan retrieve error code: ${data.code}`);
        if(data.code === 404 && data.msg === "无数据") {
          break;
        } else if(data.code !== 1) {
          throw new Error("Unable to retrieve data for block " + blockNum);
        }
      }
      result = result.concat(data.data);
    }
    result = result.map(txn => {
      return {
        ownerAddress: txn.from,
        block: txn.height,
        toAddress: txn.to,
        value: txn.value,
        timestamp: txn.time * 1000,
        hash: txn.txid,
        tokenTransfer: (txn.tokenTransfer || []).filter(t=>t.tokenSymbol===process.env.TRX_CONTRACT_SYMBOL)
      };
    });
  }
  return result;
};

const getAccount = async (address) => {
  const data = await axios.get(process.env.TRX_TRONSCAN_API_URL + "/account?address=" + address, { timeout: 10000 });
  return data.data;
};


module.exports = {
  getBlock,
  getAccount
};