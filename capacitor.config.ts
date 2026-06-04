import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.arjundark.share',
  appName: 'sHare',
  webDir: 'dist',
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystorePassword: undefined,
      keystoreAlias: undefined,
      keystoreAliasPassword: undefined,
    }
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
  server: {
    // Allow WebRTC and local WebCrypto to work inside the WebView
    androidScheme: 'https',
    cleartext: false,
  },
}

export default config
