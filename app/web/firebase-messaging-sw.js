importScripts(
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js',
);
importScripts(
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js',
);

firebase.initializeApp({
  apiKey: 'AIzaSyAdy3QIJdBgOWDnld-S5KeUSqFa2azurTs',
  appId: '1:845391905122:web:8515c656df5a7044aeac3b',
  messagingSenderId: '845391905122',
  projectId: 'tripcircule',
  authDomain: 'tripcircule.firebaseapp.com',
  storageBucket: 'tripcircule.firebasestorage.app',
});

firebase.messaging();
