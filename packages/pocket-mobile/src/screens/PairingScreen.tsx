import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parseScannedPairingQr } from '../pairing/parsePairingQr';
import { signInToGoogle, isUserCancelledSignIn } from '../auth/googleAuth';
import { usePocketSession } from '../state/PocketSessionProvider';
import { Screen, Title, Muted, AppButton, Card } from '../components/ui';
import { theme } from '../lib/theme';

/**
 * First-run only: scan the QR Desktop shows, sign in to Google (Pocket's own
 * account connection, independent of Desktop's), then download the first
 * snapshot. Nothing scanned here is ever logged or persisted as an image —
 * `parseScannedPairingQr` hands back plain values that go straight into
 * Keychain/Keystore via completePairing().
 */
export function PairingScreen() {
  const { completePairing } = usePocketSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState<{ pocketId: string; dek: Uint8Array; driveRemotePath: string; driveFileId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function handleScan(data: string) {
    if (scanned) return; // ignore further scans once one succeeded
    try {
      const { payload, dek } = parseScannedPairingQr(data);
      setScanned({ pocketId: payload.pocketId, dek, driveRemotePath: payload.drive.remotePath, driveFileId: payload.drive.fileId });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function connect() {
    if (!scanned) return;
    setBusy(true);
    setError(null);
    try {
      await signInToGoogle();
      await completePairing(scanned);
    } catch (err) {
      if (!isUserCancelledSignIn(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!permission) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} />
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <Screen style={{ justifyContent: 'center', gap: 12 }}>
        <Title>Vincular Arkode Pocket</Title>
        <Muted>Necesitamos la cámara una sola vez, para leer el código que muestra Arkode Desktop.</Muted>
        <AppButton title="Permitir cámara" onPress={requestPermission} />
      </Screen>
    );
  }

  if (scanned) {
    return (
      <Screen style={{ justifyContent: 'center', gap: 16 }}>
        <Title>Código leído</Title>
        <Card>
          <Muted>Ahora conectá tu cuenta de Google — Arkode Pocket la usa para leer el archivo publicado por Desktop.</Muted>
        </Card>
        {error && <Text style={{ color: theme.danger }}>{error}</Text>}
        {busy ? <ActivityIndicator color={theme.accent} /> : <AppButton title="Conectar con Google" onPress={connect} />}
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => handleScan(data)}
      />
      <View style={{ position: 'absolute', bottom: 40, left: 16, right: 16 }}>
        <Card>
          <Text style={{ color: theme.text, fontWeight: '600', marginBottom: 4 }}>Escaneá el código de Arkode Desktop</Text>
          <Muted>Configuración → Arkode Pocket → Vincular dispositivo</Muted>
          {error && (
            <Text style={{ color: theme.danger, marginTop: 8 }}>{error}</Text>
          )}
        </Card>
      </View>
    </View>
  );
}
