//@flow
import * as UR3U from './utilities';
import { isNumeric } from './utilitieslite';
declare var __DEV__: boolean;

export function areDependentFieldsValid(
  dependentUponInputFields: {},
  dependentInputFields: {},
  dependentValidators: {},
  errorMessages: Array<string>,
  t: (key: string) => string
){
  if (
    UR3U.objectIsUndefinedOrEmpty(dependentUponInputFields)
    || UR3U.objectIsUndefinedOrEmpty(dependentInputFields)
    || UR3U.objectIsUndefinedOrEmpty(dependentValidators)
  ){
    UR3U.addMessageToArray(
      errorMessages,
      t,
      '',
      'Input fields or validators are incomplete.'
    ); // TODO add translation
    return false;
  }

  const dependentFieldsCount = UR3U.countOfProps(dependentInputFields);
  let validatedFieldsCount = 0;

  let areDependentFieldsValid = true;
  for (const field in dependentValidators){
    if (dependentInputFields.hasOwnProperty(field)){
      const dependentValidator = dependentValidators[field];
      const keyOfDependent = dependentValidator.KeyOfDependent;

      if (dependentUponInputFields.hasOwnProperty(keyOfDependent)){
        const validationResult = dependentValidator.validate(
          dependentUponInputFields[keyOfDependent],
          dependentInputFields[field]
        );
        ++validatedFieldsCount;
        if (!validationResult.isValid){
          UR3U.addMessagesToArray(
            errorMessages,
            t,
            validationResult.errorResults
          );
          areDependentFieldsValid = false;
          // must not break for all fields to be validated
        }
      } else {
        areDependentFieldsValid = false;
        UR3U.addMessageToArray(
          errorMessages,
          t,
          '',
          `Dependent input field ${keyOfDependent} not found`
        ); // TODO add translation
      }
    } else areDependentFieldsValid = false;
  }

  if (validatedFieldsCount !== dependentFieldsCount){
    UR3U.addMessageToArray(
      errorMessages,
      t,
      'test',
      'Not all dependent fields are validated.'
    ); // TODO add translation
    areDependentFieldsValid = false;
  }

  return areDependentFieldsValid;
}

export function areRequiredFieldsValid(
  inputFields: {},
  validators: {},
  errorMessages: Array<string>,
  t: (key: string) => string
){
  if (
    UR3U.objectIsUndefinedOrEmpty(inputFields)
    || UR3U.objectIsUndefinedOrEmpty(validators)
  ){
    UR3U.addMessageToArray(
      errorMessages,
      t,
      '',
      'Input fields or validators are incomplete.'
    ); // TODO add translation
    return false;
  }

  const inputFieldsCount = UR3U.countOfProps(inputFields);
  let validatedFieldsCount = 0;

  let allAreValid = true;
  for (const field in validators){
    if (inputFields.hasOwnProperty(field)){
      const validator = validators[field];
      const validationResult = validator.validate(inputFields[field]);
      ++validatedFieldsCount;
      if (!validationResult.isValid){
        UR3U.addMessagesToArray(
          errorMessages,
          t,
          validationResult.errorResults
        );
        allAreValid = false;
        // must not break for all fields to be validated
      }
    } else allAreValid = false;
  }

  if (validatedFieldsCount !== inputFieldsCount){
    UR3U.addMessageToArray(
      errorMessages,
      t,
      'test',
      'Not all fields are validated.'
    ); // TODO add translation
    allAreValid = false;
  }

  return allAreValid;
}

// TODO check if interface could be implemented or is still needed
// interface UR3Validator
// {
// validate();
// }

// TODO move concrete validators to its own file, if needed (once too many)

export class NameValidator {
  // NOTE: no validation for now, and always optional
  validate(){
    return { isValid: true };
  }
}

export class EmailValidator {
  /* eslint-disable no-useless-escape */
  static emailRegexUnicode = /^(([^<>()\[\]\.,;:\s@\"]+(\.[^<>()\[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;
  /* eslint-enable */

  validate(input: string){
    const isEmailValid =
      input != null
      && EmailValidator.emailRegexUnicode.test(input.toLowerCase());
    if (!isEmailValid){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors.invalidemail',
            fallbackMessage: 'Please enter a valid email address.'
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class StringArrayValidator {
  _numberOfRequiredElements: number;
  _errorTranslationKey: string;
  _errorFallbackMessage: string;

  constructor(
    numberOfRequiredElements: number,
    errorTranslationKey: string,
    errorFallbackMessage: string
  ){
    this._numberOfRequiredElements = numberOfRequiredElements;
    this._errorTranslationKey = errorTranslationKey;
    this._errorFallbackMessage = errorFallbackMessage;
  }

  validate(stringArray: Array<string>){
    let countOfElementsPresent = 0;
    for (let i = 0; i < this._numberOfRequiredElements; i++){
      if (stringArray[i] == null || stringArray[i] === '') break;
      else countOfElementsPresent++;
    }

    if (countOfElementsPresent !== this._numberOfRequiredElements){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: this._errorTranslationKey,
            fallbackMessage: this._errorFallbackMessage
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class BirthdayValidator {
  static birthdayRegex = /^(19|20)\d{2}-(0?[1-9]|1[0-2])-(0?[1-9]|1\d|2\d|3[01])$/;
  // TODO date formats/localizations should be store in a config, and instead of regex can just be Date.Parse
  _isOptional = false;

  constructor(options: { isOptional: boolean }){
    if (options) if (options.isOptional) this._isOptional = true;
  }

  validate(ISODate: string){
    if (this._isOptional && ISODate === '') return { isValid: true };

    let isBirthdayValid = BirthdayValidator.birthdayRegex.test(ISODate);
    if (isBirthdayValid){
      const dateToday = new Date();
      const inputDate = new Date(ISODate);
      if (dateToday < inputDate) isBirthdayValid = false;
      else {
        const timeDiffInMilliseconds =
          dateToday.getTime() - inputDate.getTime();
        const millisecondsInOneDay = 1000 * 60 * 60 * 24;
        const ageInDays = timeDiffInMilliseconds / millisecondsInOneDay;
        const minimumAgeInDays = 1; // TODO TEMP increase to specs

        if (ageInDays < minimumAgeInDays) isBirthdayValid = false;
      }
    }

    if (!isBirthdayValid){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors.invalidbirthdate',
            fallbackMessage: 'Please enter a valid birthdate.'
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class GenderValidator {
  _isOptional = false;

  constructor(options: { isOptional: boolean }){
    if (options) if (options.isOptional) this._isOptional = true;
  }

  validate(gender: string){
    // TODO define gender type/enum
    if (this._isOptional && gender === '') return { isValid: true };

    const isGenderValid = gender.length > 0;

    if (!isGenderValid){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors.genderrequirement',
            fallbackMessage: 'Please select a gender.'
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class PasswordValidator {
  validate(input: string){
    const minPwlength = __DEV__ ? 2 : 12;
    const passwordIsTooShort = input != null && input.length < minPwlength;

    if (passwordIsTooShort){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey:
              'common:inputerrors.passwordrequirement'
              + (__DEV__ ? 'Override' : ''),
            fallbackMessage: `Password should be at least ${minPwlength} characters.`
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class ConfirmpasswordValidator {
  KeyOfDependent: string;

  constructor(keyOfDependent: string){
    this.KeyOfDependent = keyOfDependent;
  }

  validate(valueOfUpdatedConfirmPassword: string, valueOfPassword: string){
    const valuesAreTheSame = valueOfPassword === valueOfUpdatedConfirmPassword;

    if (valuesAreTheSame) return { isValid: true };
    else {
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors.passwordsdonotmatch',
            fallbackMessage: 'The passwords do not match.'
          }
        ]
      };
    }
  }
}

export class PINValidator {
  validate(input: string){
    const is4digit = /^[\d]{4}$/.test(input);

    if (!is4digit){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors:pinshouldbe4digit',
            fallbackMessage: 'PIN should be a four digit number.'
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class RequiredFieldValidator {
  _fieldNameTKey = '';

  constructor(fieldNameTKey: string){
    if (fieldNameTKey) this._fieldNameTKey = fieldNameTKey;
  }

  validate(input: string){
    if (!this._isValid(input)){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors.fieldnameisrequired',
            translationOptions: { fieldNameTKey: this._fieldNameTKey },
            fallbackMessage: `Field '${
              this._fieldNameTKey
            }' is a required field.`
          }
        ]
      };
    } else return { isValid: true };
  }

  _isValid(input: string): boolean{
    return input != null && input.length > 0;
  }
}

export class NumberFieldValidator {
  _fieldNameTKey = '';

  constructor(fieldNameTKey: string){
    if (fieldNameTKey) this._fieldNameTKey = fieldNameTKey;
  }

  validate(input: number){
    const isValid: boolean = input > 0;

    return this._validate(isValid);
  }

  _validate(isValid: boolean, errorTKey?: string){
    if (!isValid){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: errorTKey || 'common:inputerrors.numberiszero',
            translationOptions: { fieldNameTKey: this._fieldNameTKey },
            fallbackMessage: `'${
              this._fieldNameTKey
            }' must be greater than zero.`
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class WalletAddressValidator {
  _base58CharsLookupTable = {};
  constructor(){
    const base58chars =
      '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let i = 0; i < base58chars.length; ++i)
      this._base58CharsLookupTable[base58chars[i]] = i;
  }

  validate(input: string){
    // P2PKH keys have lengths from 26-35
    let isValid = input != null && input.length > 25 && input.length < 36;
    if (isValid){
      for (let i = 0; i < input.length; ++i){
        if (this._base58CharsLookupTable[input[i]] === undefined){
          isValid = false;
          break;
        }
      }
    }
    // TODO PROD validate hash

    if (!isValid){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors.invalidwalletaddress',
            fallbackMessage: 'Please enter a valid wallet address.'
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class ConfirmationCodeValidator {
  _base16CharsLookupTable = {};
  constructor(){
    const base16chars = '0123456789ABCDEFabcdef';
    for (let i = 0; i < base16chars.length; ++i)
      this._base16CharsLookupTable[base16chars[i]] = i;
  }

  validate(input: string){
    let isValid = input != null && input.length === 128;
    if (isValid){
      for (let i = 0; i < input.length; ++i){
        if (this._base16CharsLookupTable[input[i]] === undefined){
          isValid = false;
          break;
        }
      }
    }

    if (!isValid){
      return {
        isValid: false,
        errorResults: [
          {
            translationKey: 'common:inputerrors.invalidconfirmationcode',
            fallbackMessage: 'Please enter a valid confirmation code.'
          }
        ]
      };
    } else return { isValid: true };
  }
}

export class AMTCAmountValidator {
  _shouldBeGreaterThanZero = true;

  constructor(
    options?: { shouldBeGreaterThanZero?: boolean } = {
      shouldBeGreaterThanZero: true
    }
  ){
    this._shouldBeGreaterThanZero = options.shouldBeGreaterThanZero;
  }

  validate(amountString: string){
    let isValid =
      amountString != null && amountString !== '' && isNumeric(amountString);
    const errorResults = [];

    if (!isValid){
      errorResults.push({
        translationKey: 'common:inputerrors.invalidamount',
        fallbackMessage: 'Please enter a valid amount.'
      });
    } else if (this._shouldBeGreaterThanZero){
      isValid = parseFloat(amountString) > 0;

      if (!isValid){
        errorResults.push({
          translationKey: 'common:inputerrors.amountiszero',
          fallbackMessage: 'Please enter an amount greater than zero.'
        });
      }
    }

    if (isValid){
      const isWholeNumberOnly = amountString.indexOf('.') === -1;

      if (isWholeNumberOnly){
        isValid = amountString.length <= 10;

        if (!isValid){
          errorResults.push({
            translationKey: 'common:inputerrors.amountistoolarge',
            fallbackMessage: 'Amount is too large.'
          });
        }
      } else {
        const parts = amountString.split('.');

        const zeroTrimmedIntegerPart = parts[0].replace(/^0+/, '');

        isValid = zeroTrimmedIntegerPart.length <= 10;

        if (!isValid){
          errorResults.push({
            translationKey: 'common:inputerrors.amountistoolarge',
            fallbackMessage: 'Amount is too large.'
          });
        }

        if (isValid && parts[1]){
          // 'nnn.' is considered as nnn
          const fractionalPart = parts[1];

          isValid = fractionalPart.length <= 7;

          if (!isValid){
            errorResults.push({
              translationKey:
                'common:inputerrors.amountsfractionalpartistoolong',
              fallbackMessage: 'Amount\'s fractional part is too long.'
            });
          }
        }
      }
    }

    return { isValid, errorResults };
  }
}

export class IntegerQuantityValidator {
  _shouldBeGreaterThanZero = true;
  _shouldBeNonZero = false;

  constructor(
    options?: any = { shouldBeGreaterThanZero: true, shouldBeNonZero: false }
  ){
    this._shouldBeGreaterThanZero = options.shouldBeGreaterThanZero;
    this._shouldBeNonZero = options.shouldBeNonZero;
  }

  validate(quantityString: string){
    let isValid =
      quantityString != null
      && quantityString !== ''
      && Number.isInteger(parseFloat(quantityString));

    const errorResults = [];

    if (!isValid){
      errorResults.push({
        translationKey: 'common:inputerrors.invalidquantity',
        fallbackMessage: 'Please enter a valid quantity.'
      });
    } else if (this._shouldBeGreaterThanZero){
      isValid = parseInt(quantityString) > 0;

      if (!isValid){
        errorResults.push({
          translationKey: 'common:inputerrors.quantityiszero',
          fallbackMessage: 'Please enter a quantity greater than zero.'
        });
      }
    } else if (this._shouldBeNonZero){
      isValid = parseInt(quantityString) !== 0;

      if (!isValid){
        errorResults.push({
          translationKey: 'common:inputerrors.invalidquantity',
          fallbackMessage: 'Please enter a valid quantity.'
        });
      }
    }

    return { isValid, errorResults };
  }
}
