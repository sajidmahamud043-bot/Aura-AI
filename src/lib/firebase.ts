import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import { getAnalytics, isSupported } from 'firebase/analytics';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
// CRITICAL: The app will break without specifying the databaseId from config
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth();

// Initialize Analytics if supported and measurementId is present
export const initAnalytics = async () => {
  if (firebaseConfig.measurementId && await isSupported()) {
    return getAnalytics(app);
  }
  return null;
};
initAnalytics();

// Validate Connection
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();
