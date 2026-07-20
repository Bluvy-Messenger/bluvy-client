import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'bluvy.application.official',
  appName: 'Bluvy Messenger',
  webDir:  'www',
  plugins: {
    EdgeToEdge: {
      statusBarColor:     '#FFFFFF',
      navigationBarColor: '#FFFFFF',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
