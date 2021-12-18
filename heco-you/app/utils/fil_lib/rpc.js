const axios = require("axios");
const REQUEST_LIMIT=5;
const EXPLORER_RATE_LIMIT= 30;
const ONE_SECOND = 1000;
let requestCnt=0;
let last_exp_req_cnt_time=0;
let last_exp_req_cnt =0;


const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};


const call = async (method, params) => {    
  let data= {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "Filecoin."+method,
    "params": params 
  };	
  let result =await axios.post(process.env.FIL_RPC_URL, data,{headers:{Authorization:process.env.FIL_RPC_AUTH}});
  return result.data;
};

const asyncall = async (method, params, callback) => {  
  if (requestCnt>=REQUEST_LIMIT) return false;
  requestCnt ++;	
  let data= {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "Filecoin."+method,
    "params": params 
  };
  axios.post(process.env.FIL_RPC_URL, data,{headers:{Authorization:process.env.FIL_RPC_AUTH}}).then(response=>{requestCnt--; callback(response.data);});
  return true;
};

const expl = async (url, params) => {  
  let now = new Date().getTime();
  let delta= now-last_exp_req_cnt_time;
  //if current time is already more than 1 minute away from the last time we started count, we can now restart the count
  if (delta>ONE_SECOND){
    last_exp_req_cnt_time=now;
    last_exp_req_cnt=1;	   
  } else {
    //if the current time is still within the same minute when we started count, and we have not yet reached the limit, just proceed
    if (last_exp_req_cnt<EXPLORER_RATE_LIMIT){
      last_exp_req_cnt=last_exp_req_cnt+1;
    } else {
      //add 1s just be sure
      let waittime = ONE_SECOND- delta +1000;		   
      await sleep(waittime);
      last_exp_req_cnt_time=new Date().getTime();		   
      last_exp_req_cnt=1;
    }
  }  
  return await axios.get(process.env.FIL_EXPLORER_URL+ url, {params: params});    
};


const Strings = {
  create : (function() {
    var regexp = /\${([^{]+)}/g;
    return function(str, o) {
      return str.replace(regexp, function(ignore, key){
        return (key = o[key]) == null ? "" : key;
      });
    };
  })()
};

const expl2 = async (url, urlParams, params) => {  
  let now = new Date().getTime();
  let delta= now-last_exp_req_cnt_time;
  //if current time is already more than 1 minute away from the last time we started count, we can now restart the count
  if (delta>ONE_SECOND){
    last_exp_req_cnt_time=now;
    last_exp_req_cnt=1;	   
  } else {
    //if the current time is still within the same minute when we started count, and we have not yet reached the limit, just proceed
    if (last_exp_req_cnt<EXPLORER_RATE_LIMIT){
      last_exp_req_cnt=last_exp_req_cnt+1;
    } else {
      //add 1s just be sure
      let waittime = ONE_SECOND- delta +1000;		   
      await sleep(waittime);
      last_exp_req_cnt_time=new Date().getTime();		   
      last_exp_req_cnt=1;
    }
  }    
  return await axios.get(process.env.FIL_EXPLORER_URL+ Strings.create(url,urlParams), {params: params});    
};


module.exports = {
  call,
  asyncall,
  expl,
  expl2
};
