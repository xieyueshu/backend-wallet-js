//@flow

// This module should be pure javascript, no React

export function objectIsUndefinedOrEmpty(obj?: {}){
  // NOTE: '==' should only used when comparing with null
  return obj == null || Object.keys(obj).length === 0;
}

export function objectIsNotEmpty(obj: {}){
  return Object.keys(obj).length !== 0;
}

export function countOfProps(obj: {}){
  return Object.keys(obj).length;
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

export function allPropertiesOfBAreEquivalentInA(A: {}, B: {}){
  for (const key in B) if (B[key] !== A[key]) return false;

  return true;
}

export function copyPropertiesOfAToB(A: {}, B: {}){
  Object.keys(A).forEach(function(key){
    B[key] = A[key];
  });
}

export function copyPropertiesPresentInB_FromAToB(A: {}, B: {}){
  Object.keys(B).forEach(function(key){
    B[key] = A[key];
  });
}

export function forceCastToNumber(n: ?number, valueIfNull: number = 0): number{
  if (!n) return valueIfNull;

  return ((n: any): number);
}

export function numberWithCommas(n: number): string{
  var parts = n.toString().split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

export function nullableNumberWithCommas(
  n: ?number,
  valueIfNull: string = '0'
): string{
  if (!n) return valueIfNull;

  return numberWithCommas(forceCastToNumber(n));
}

export function removeItemFromArrayOfObjects(
  itemToRemove: {},
  arrayOfObjects: Array<any>
){
  for (let i = 0; i < arrayOfObjects.length; ++i){
    if (allPropertiesOfBAreEquivalentInA(arrayOfObjects[i], itemToRemove)){
      arrayOfObjects.splice(i, 1 /*number of items to delete*/);
      return true;
    }
  }
  return false;
}

export function addMessageToArray(
  errorMessages: Array<string>,
  t: (key: string) => string,
  translationKey: string,
  fallbackMessage: string
){
  let message = fallbackMessage;
  if (t && translationKey) message = t(translationKey);
  errorMessages.push(message);
}

export function addMessagesToArray(
  errorMessages: Array<string>,
  t: (key: string) => string,
  messages: Array<{ translationKey: string, fallbackMessage: string }>
){
  for (let i = 0; i < messages.length; ++i){
    const errorResult = messages[i];
    let message = errorResult.fallbackMessage;
    message = t(errorResult.translationKey);

    errorMessages.push(message);
  }
}

export function createButtonAndInputStateWithDependentFields(
  updatedField: {},
  inputFields: {},
  requiredDependentInputFields: {},
  optionalInputFieldsKeys?: {}
): {
  newButtonState: { isButtonEnabled?: boolean },
  updatedInputFields: any
}{
  const newStates = createStatesBasedOnUpdatedField(
    updatedField,
    inputFields,
    optionalInputFieldsKeys
  );
  const dependentStates = createStatesBasedOnUpdatedField(
    updatedField,
    requiredDependentInputFields,
    optionalInputFieldsKeys
  );

  if (
    newStates.newButtonState.isButtonEnabled
    && !dependentStates.newButtonState.isButtonEnabled
  ){
    newStates.newButtonState.isButtonEnabled =
      dependentStates.newButtonState.isButtonEnabled;
  }

  return newStates;
}

export function createStatesBasedOnUpdatedField(
  updatedField: {},
  inputFields: {},
  optionalInputFieldsKeys?: {} = {}
): {
  newButtonState: { isButtonEnabled?: boolean },
  updatedInputFields: any
}{
  let editedKey,
    updatedValue,
    newButtonState = {};

  // create newButtonState
  for (editedKey in updatedField){
    // set editedKey
    updatedValue = updatedField[editedKey]; //get updated value
    newButtonState = createButtonStateBasedOnRequiredFields(
      editedKey,
      updatedValue,
      inputFields,
      optionalInputFieldsKeys
    );
  }

  // create updatedInputFields
  const updatedFields = inputFields;
  if (editedKey && inputFields.hasOwnProperty(editedKey))
    updatedFields[editedKey] = updatedValue;

  return { newButtonState: newButtonState, updatedInputFields: updatedFields };
}

export function createButtonStateBasedOnRequiredFields(
  editedKey: string,
  editedValue: string,
  inputFields: {},
  optionalInputFieldsKeys?: {} = {}
){
  let disableButtonWhenValueIsEmpty = true;
  if (optionalInputFieldsKeys[editedKey]) disableButtonWhenValueIsEmpty = false;
  // TODO editedValue should have property isEmpty
  else disableButtonWhenValueIsEmpty = editedValue.length <= 0;

  if (disableButtonWhenValueIsEmpty) return createDisabledButtonState();
  else {
    if (
      allRequiredPropertiesAreNotEmptyExceptFor(
        inputFields,
        editedKey,
        optionalInputFieldsKeys
      )
    )
      return createEnabledButtonState();
    else return createDisabledButtonState();
  }
}

function allRequiredPropertiesAreNotEmptyExceptFor(
  inputFields,
  exceptForKey,
  optionalInputFieldsKeys
){
  if (objectIsNotEmpty(inputFields)){
    for (const key in inputFields){
      if (key !== exceptForKey && !optionalInputFieldsKeys[key]){
        const fieldIsEmpty = inputFields[key].length === 0;
        if (fieldIsEmpty) return false;
      }
    }
  } else return false;

  return true;
}

export function createEnabledButtonState(){
  return { isButtonEnabled: true };
}

export function createDisabledButtonState(){
  return { isButtonEnabled: false };
}

export function joinStringsWithNewline(a: string[]){
  return a.join('\n');
}

export function getISODateStringXyearsAgo(
  yearsAgo: number,
  referenceDate: Date = new Date()
){
  return new Date(
    Date.UTC(
      referenceDate.getUTCFullYear() - yearsAgo,
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate()
    )
  )
    .toISOString()
    .substring(0, 10);
}
