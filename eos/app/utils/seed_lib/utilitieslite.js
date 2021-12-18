//@flow
declare var Promise: any;
declare var setTimeout: any;
//$FICRM
import { limit as szlimit } from 'stringz';
// This module should be pure javascript, no React

export function isNumeric(n: string){
  return !isNaN(parseFloat(n)) && isFinite(n);
}

export function createMergedObject(obj1: {}, obj2: {}){
  const merged = {};

  Object.keys(obj1).forEach(function(key){
    merged[key] = obj1[key];
  });
  Object.keys(obj2).forEach(function(key){
    merged[key] = obj2[key];
  });

  return merged;
}

export function arrayToObjectUsingTxidAsKeys(items: Array<any>, addProps?: {}){
  return arrayToObjectUsingIdPropAsKeys(items, 'txid', addProps);
}

export function arrayToObjectUsingIdPropAsKeys(
  items: Array<any>,
  idProp: string,
  addProps?: {}
){
  const result = {};
  for (let i = 0; i < items.length; ++i){
    const item = items[i];
    if (addProps) for (const key in addProps) item[key] = addProps[key];

    result[item[idProp]] = item;
  }

  return result;
}

export function truncateStringDefault20(s: string, maxLength?: number = 20){
  const newlinesRemoved = s ? s.trim().replace(/(\r\n|\n|\r|\t)/g, ' ') : '';

  if (newlinesRemoved.length > maxLength){
    // NOTE ensure that string is not truncated between UTF bytes
    return szlimit(newlinesRemoved, maxLength) + '...';
  } else return newlinesRemoved;
}

export function sleepThen(
  timeInMs: number,
  functionAfter?: () => any = () => {}
){
  return new Promise(resolve => {
    setTimeout(resolve, timeInMs);
  }).then(functionAfter);
}

export function toDateForItemHeaders(blockTimeInMs: number){
  return new Date(blockTimeInMs).toDateString();
}

export function hexToASCII(hex: string){
  let str = '';
  for (let i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return str;
}

export function isFileAnImage(file: null | string){
  return file != null && file !== '' && file.startsWith('data:image');
}

// const _locale = getLocale();
// declare var navigator: any;
// function getLocale(){
//   if (navigator){
//     if (navigator.languages != undefined && navigator.languages.length > 0)
//       return navigator.languages[0];
//     else if (navigator.language) return navigator.language;
//     else return 'en-US';
//   } else return 'en-US';
// }

export function tryJSONparseToObject(raw: string){
  let result = {};
  try {
    result = JSON.parse(raw);
  } catch (error){
    result = {};
  }
  return result;
}

export function newDateWithTimezoneAdjusted(blockTimeInMs: number){
  const dt = new Date(blockTimeInMs);

  return new Date(blockTimeInMs - 60000 * dt.getTimezoneOffset());
}

export function toDateTimeString(dt: Date){
  const dtz = new Date(dt.getTime() - 60000 * dt.getTimezoneOffset());

  const result = toDateString(dtz) + ' ' + toTimeString(dtz); // YYYY-MM-DD HH:mm:ss

  return result;
}
export function toDateString(dt: Date){
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
}
export function toTimeString(dt: Date){
  return dt.toISOString().slice(11, 19); // HH:mm:ss
}
export function tryParseIssuedDateTime(rawInGMT0: string){
  // raw format is '28/01/2019: 03:02:45'
  const raw = rawInGMT0;

  try {
    const reorderedYYYYMMDDhhmmssGMT0 =
      raw.substring(6, 10)
      + '-'
      + raw.substring(3, 5)
      + '-'
      + raw.substring(0, 2)
      + 'T'
      + raw.substring(12, 20)
      + '.000Z';
    return toDateTimeString(new Date(reorderedYYYYMMDDhhmmssGMT0));
  } catch (e){
    //eslint-disable-next-line no-console
    console.log('Unsupported datetime string:', raw);
  }

  return raw;
}
