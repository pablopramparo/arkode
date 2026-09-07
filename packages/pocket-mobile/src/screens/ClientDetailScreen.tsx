import { FlatList, Linking, Pressable, Text, View } from 'react-native';
import type { PocketSnapshotPayload } from 'pocket-shared';
import { theme } from '../lib/theme';
import { Screen, Muted } from '../components/ui';
import type { Route } from '../navigation';

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
    <Screen>
      <Pressable onPress={onBack} style={{ marginBottom: 8 }}>
        <Text style={{ color: theme.accent }}>‹ Clientes</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontSize: 22, fontWeight: '700', marginBottom: 16 }}>{client?.name ?? 'Cliente'}</Text>

      <Text style={{ color: theme.muted, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>CREDENCIALES</Text>
      <FlatList
        data={credentials}
        keyExtractor={(c) => c.id}
        scrollEnabled={false}
        ListEmptyComponent={<Muted>Sin credenciales.</Muted>}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onNavigate({ name: 'credential', credentialId: item.id })}
            style={{ backgroundColor: theme.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 8 }}
          >
            <Text style={{ color: theme.text, fontWeight: '600' }}>{item.name}</Text>
            <Text style={{ color: theme.muted, fontSize: 13 }}>{item.kind}{item.host ? ` · ${item.host}` : ''}</Text>
          </Pressable>
        )}
      />

      {urls.length > 0 && (
        <>
          <Text style={{ color: theme.muted, fontSize: 13, fontWeight: '600', marginTop: 16, marginBottom: 6 }}>URLs</Text>
          <FlatList
            data={urls}
            keyExtractor={(u) => u.id}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => void Linking.openURL(item.url)}
                style={{ backgroundColor: theme.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 8 }}
              >
                <Text style={{ color: theme.text, fontWeight: '600' }}>{item.name}</Text>
                <Text style={{ color: theme.accent, fontSize: 13 }} numberOfLines={1}>{item.url}</Text>
              </Pressable>
            )}
          />
        </>
      )}
    </Screen>
  );
}
