import { useEffect } from 'react';
import { Alert, Pressable, ScrollView, Text } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import type { PocketSnapshotPayload } from 'pocket-shared';
import { theme } from '../lib/theme';
import { FieldRow } from '../components/FieldRow';
import { Muted } from '../components/ui';

/**
 * Read-only viewer/copy surface — this is the whole point of Pocket. A
 * private key IS shown/copyable here when a credential has one (see
 * pocket-shared/types.ts's own doc comment for why that's a deliberate
 * inclusion, not an oversight), but this screen never writes it to a file,
 * never offers to "connect" or "import" it anywhere, and never shells out
 * to anything — copy-and-paste is the only action available.
 */
export function CredentialDetailScreen({ payload, credentialId, onBack }: { payload: PocketSnapshotPayload; credentialId: string; onBack: () => void }) {
  const credential = payload.credentials.find((c) => c.id === credentialId);
  const client = credential ? payload.clients.find((c) => c.id === credential.clientId) : undefined;

  // Extra screenshot/recent-apps-thumbnail hardening specifically while
  // secrets are on screen. Android: FLAG_SECURE under the hood — actually
  // blocks screenshots and the task-switcher thumbnail. iOS: this call is a
  // no-op for screenshots (Apple provides no API to block them) but does
  // let us detect an active screen recording if ever needed later.
  useEffect(() => {
    void ScreenCapture.preventScreenCaptureAsync();
  }, []);

  if (!credential) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.background, padding: 16 }}>
        <Pressable onPress={onBack}>
          <Text style={{ color: theme.accent }}>‹ Volver</Text>
        </Pressable>
        <Muted>Esta credencial ya no está disponible en la última publicación.</Muted>
      </ScrollView>
    );
  }

  const secret = credential.secret;
  const hasCustom = secret.custom && Object.keys(secret.custom).length > 0;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background, padding: 16 }}>
      <Pressable onPress={onBack} style={{ marginBottom: 8 }}>
        <Text style={{ color: theme.accent }}>‹ {client?.name ?? 'Volver'}</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontSize: 22, fontWeight: '700', marginBottom: 4 }}>{credential.name}</Text>
      <Muted>{[credential.kind, credential.environment].filter(Boolean).join(' · ')}</Muted>

      <FieldRow label="Host" value={credential.host} />
      <FieldRow label="Puerto" value={credential.port} />
      <FieldRow label="Base de datos" value={credential.databaseName} />
      <FieldRow label="Usuario" value={credential.username} />
      <FieldRow label="Contraseña" value={secret.password ?? null} secret />
      <FieldRow label="Token" value={secret.token ?? null} secret />
      <FieldRow label="Client secret" value={secret.clientSecret ?? null} secret />
      <FieldRow label="Clave privada" value={secret.privateKey ?? null} secret />
      <FieldRow label="Passphrase de la clave" value={secret.privateKeyPassphrase ?? null} secret />
      {hasCustom &&
        Object.entries(secret.custom!).map(([key, value]) => <FieldRow key={key} label={key} value={value} secret />)}
      <FieldRow label="URL" value={credential.url} />
      <FieldRow label="Notas" value={secret.notes ?? null} secret />
      <FieldRow label="Descripción" value={credential.description} />

      {credential.tags.length > 0 && (
        <Pressable onLongPress={() => Alert.alert('Tags', credential.tags.join(', '))} style={{ marginTop: 12 }}>
          <Muted>{credential.tags.join(' · ')}</Muted>
        </Pressable>
      )}
    </ScrollView>
  );
}
