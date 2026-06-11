import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

const firebaseConfig = {
  apiKey: 'AIzaSyDBs1S33VsltUlV1aznVyMYURxzH2IZFGk',
  databaseURL: 'https://ydm-bingo-realtime-default-rtdb.firebaseio.com'
}

const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)
