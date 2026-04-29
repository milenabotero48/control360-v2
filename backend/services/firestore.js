const axios = require('axios');

const FIRESTORE_PROJECT = 'control360-v2';
const DATABASE = '(default)';

const getFirestoreUrl = (collection, docId = null) => {
  const base = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/${DATABASE}/documents/${collection}`;
  return docId ? `${base}/${docId}` : base;
};

// GET - Listar documentos
const getDocuments = async (collection) => {
  try {
    const url = getFirestoreUrl(collection);
    const response = await axios.get(url);
    
    const documents = response.data.documents || [];
    return documents.map(doc => ({
      id: doc.name.split('/').pop(),
      ...convertFirestoreToJson(doc.fields)
    }));
  } catch (error) {
    console.error('Error fetching documents:', error.message);
    return [];
  }
};

// POST - Crear documento
const createDocument = async (collection, data) => {
  try {
    const url = getFirestoreUrl(collection);
    const payload = {
      fields: convertJsonToFirestore(data)
    };
    
    const response = await axios.post(url, payload);
    return {
      id: response.data.name.split('/').pop(),
      ...data
    };
  } catch (error) {
    console.error('Error creating document:', error.message);
    throw error;
  }
};

// GET - Obtener un documento
const getDocument = async (collection, docId) => {
  try {
    const url = getFirestoreUrl(collection, docId);
    const response = await axios.get(url);
    
    return {
      id: response.data.name.split('/').pop(),
      ...convertFirestoreToJson(response.data.fields)
    };
  } catch (error) {
    console.error('Error fetching document:', error.message);
    return null;
  }
};

// PUT - Actualizar documento
const updateDocument = async (collection, docId, data) => {
  try {
    const url = getFirestoreUrl(collection, docId);
    const payload = {
      fields: convertJsonToFirestore(data)
    };
    
    const response = await axios.patch(url, payload);
    return {
      id: response.data.name.split('/').pop(),
      ...data
    };
  } catch (error) {
    console.error('Error updating document:', error.message);
    throw error;
  }
};

// Convertir JSON a formato Firestore
const convertJsonToFirestore = (obj) => {
  const result = {};
  for (const key in obj) {
    const value = obj[key];
    if (value === null) result[key] = { nullValue: null };
    else if (typeof value === 'boolean') result[key] = { booleanValue: value };
    else if (typeof value === 'number') result[key] = { integerValue: value.toString() };
    else if (typeof value === 'string') result[key] = { stringValue: value };
    else if (value instanceof Date) result[key] = { timestampValue: value.toISOString() };
    else if (Array.isArray(value)) result[key] = { arrayValue: { values: value.map(v => convertJsonToFirestore({v}).v) } };
    else if (typeof value === 'object') result[key] = { mapValue: { fields: convertJsonToFirestore(value) } };
  }
  return result;
};

// Convertir Firestore a JSON
const convertFirestoreToJson = (fields) => {
  if (!fields) return {};
  const result = {};
  for (const key in fields) {
    const field = fields[key];
    if (field.stringValue) result[key] = field.stringValue;
    else if (field.integerValue) result[key] = parseInt(field.integerValue);
    else if (field.booleanValue !== undefined) result[key] = field.booleanValue;
    else if (field.timestampValue) result[key] = new Date(field.timestampValue);
    else if (field.nullValue !== undefined) result[key] = null;
    else if (field.mapValue) result[key] = convertFirestoreToJson(field.mapValue.fields);
    else if (field.arrayValue) result[key] = field.arrayValue.values || [];
  }
  return result;
};

module.exports = { getDocuments, createDocument, getDocument, updateDocument };