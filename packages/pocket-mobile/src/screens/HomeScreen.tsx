import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import type { PocketSnapshotPayload } from 'pocket-shared';
import { searchPocketSnapshot } from '../search/searchCredentials';
import { freshnessBannerFor } from '../sync/freshness';
import { usePocketSession } from '../state/PocketSessionProvider';
import { theme } from '../lib/theme';
import { Screen, Muted } from '../components/ui';
import type { Route } from '../navigation';

export function HomeScreen({
  payload,
  lastGoodGeneratedAt,
  lastOutcome,
  refreshing,
  onNavigate,
}: {
  payload: PocketSnapshotPayload;
  lastGoodGeneratedAt: string;
  lastOutcome: Parameters<typeof freshnessBannerFor>[1];
  refreshing: boolean;
  onNavigate: (route: Route) => void;
}) {
  const { refreshNow } = usePocketSession();
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchPocketSnapshot(payload, query), [payload, query]);
  const banner = freshnessBannerFor(lastGoodGeneratedAt, lastOutcome);
  const bannerColor =
    banner.kind === 'fresh' ? theme.muted : banner.kind === 'possibly_revoked' || banner.kind === 'unsupported_format' ? theme.danger : theme.warning;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: '700' }}>Arkode Pocket</Text>
        <Pressable onPress={() => onNavigate({ name: 'settings' })}>
          <Text style={{ color: theme.muted, fontSize: 22 }}>⚙︎</Text>
        </Pressable>
      </View>

      <TextInput
        placeholder="Buscar cliente o credencial"
        placeholderTextColor={theme.muted}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          color: theme.text,
          fontSize: 16,
          marginBottom: 10,
        }}
      />

      <Pressable onPress={() => void refreshNow()} style={{ marginBottom: 12 }}>
        <Text style={{ color: bannerColor, fontSize: 13 }}>{refreshing ? 'Actualizando…' : banner.label} · tocá para actualizar</Text>
      </Pressable>

      {query.trim().length === 0 && payload.clients.length > 0 && (
        <FlatList
          horizontal
          data={payload.clients}
          keyExtractor={(c) => c.id}
          showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 12, flexGrow: 0 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onNavigate({ name: 'client', clientId: item.id })}
              style={{
                backgroundColor: theme.surfaceAlt,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: theme.border,
                paddingHorizontal: 14,
                paddingVertical: 8,
                marginRight: 8,
              }}
            >
              <Text style={{ color: theme.text, fontSize: 13 }}>{item.name}</Text>
            </Pressable>
          )}
        />
      )}

      <FlatList
        data={results.credentials}
        keyExtractor={(r) => r.credential.id}
        ListEmptyComponent={<Muted>No se encontraron credenciales.</Muted>}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onNavigate({ name: 'credential', credentialId: item.credential.id })}
            style={{
              backgroundColor: theme.surface,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: theme.border,
              padding: 12,
              marginBottom: 8,
            }}
          >
            <Text style={{ color: theme.text, fontWeight: '600' }}>{item.credential.name}</Text>
            <Text style={{ color: theme.muted, fontSize: 13 }}>
              {item.clientName} · {item.credential.kind}
              {item.credential.host ? ` · ${item.credential.host}` : ''}
            </Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}
