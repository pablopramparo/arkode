import { Linking } from 'react-native';
import type { PocketSnapshotPayload } from 'pocket-shared';
import { FieldRow } from '../components/FieldRow';
import { AppButton, BackLink, Muted, Screen } from '../components/ui';

/**
 * A URL is a first-class Pocket entity, same as a credential — it needs its
 * own entry point to copy the address, not just an instant jump into an
 * external browser. Tapping a URL row used to call Linking.openURL()
 * directly, with no way to copy it from inside Pocket at all — reported
 * directly as a real gap ("no me deja entrar a la URL para copiar").
 * "Abrir" still exists as an explicit, separate action for when the user
 * actually wants to navigate there.
 */
export function UrlDetailScreen({ payload, urlId, onBack }: { payload: PocketSnapshotPayload; urlId: string; onBack: () => void }) {
  const url = payload.urls.find((u) => u.id === urlId);
  const client = url ? payload.clients.find((c) => c.id === url.clientId) : undefined;

  if (!url) {
    return (
      <Screen scroll>
        <BackLink label="Volver" onPress={onBack} />
        <Muted>Esta URL ya no está disponible en la última publicación.</Muted>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <BackLink label={client?.name ?? 'Volver'} onPress={onBack} />
      <FieldRow label="Nombre" value={url.name} />
      <FieldRow label="URL" value={url.url} />
      <FieldRow label="Descripción" value={url.description} />
      <AppButton title="Abrir" onPress={() => void Linking.openURL(url.url)} style={{ marginTop: 16 }} />
    </Screen>
  );
}
