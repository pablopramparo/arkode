import { Linking, Pressable, Text } from 'react-native';
import type { PocketSnapshotPayload } from 'pocket-shared';
import { theme } from '../lib/theme';
import { Screen, Muted, NavRow, SectionHeader } from '../components/ui';
import { credentialKindIcon, credentialKindLabel } from '../lib/credentialKindLabels';
import type { Route } from '../navigation';

/**
 * A single scrollable Screen, not two independently `scrollEnabled={false}`
 * FlatLists — that was the real scroll bug here: with the outer Screen also
 * non-scrolling, a client with enough credentials+URLs to exceed the
 * viewport had genuinely no way to reach the rest of the content.
 */
export function ClientDetailScreen({
  payload,
  clientId,
  onNavigate,
  onBack,
}: {
  payload: PocketSnapshotPayload;
  clientId: string;
  onNavigate: (route: Route) => void;
  onBack: () => void;
}) {
  const client = payload.clients.find((c) => c.id === clientId);
  const credentials = payload.credentials.filter((c) => c.clientId === clientId);
  const urls = payload.urls.filter((u) => u.clientId === clientId);

  return (
    <Screen scroll>
      <Pressable onPress={onBack} style={{ marginBottom: 8 }} hitSlop={12}>
        <Text style={{ color: theme.accent }}>‹ Clientes</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontSize: 22, fontWeight: '700', marginBottom: 4 }}>{client?.name ?? 'Cliente'}</Text>

      <SectionHeader title="CREDENCIALES" count={credentials.length} />
      {credentials.length === 0 && <Muted>Sin credenciales.</Muted>}
      {credentials.map((item) => (
        <NavRow
          key={item.id}
          icon={credentialKindIcon(item.kind)}
          title={item.name}
          subtitle={`${credentialKindLabel(item.kind)}${item.host ? ` · ${item.host}` : ''}`}
          onPress={() => onNavigate({ name: 'credential', credentialId: item.id })}
        />
      ))}

      {urls.length > 0 && (
        <>
          <SectionHeader title="URLs" count={urls.length} />
          {urls.map((item) => (
            <NavRow key={item.id} icon="🔗" title={item.name} subtitle={item.url} onPress={() => void Linking.openURL(item.url)} />
          ))}
        </>
      )}
    </Screen>
  );
}
