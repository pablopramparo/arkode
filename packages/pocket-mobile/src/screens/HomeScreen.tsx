import { useMemo, useState } from 'react';
import { Image, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PocketSnapshotPayload } from 'pocket-shared';
import { searchPocketSnapshot } from '../search/searchCredentials';
import { credentialKindIcon, credentialKindLabel } from '../lib/credentialKindLabels';
import { freshnessBannerFor } from '../sync/freshness';
import { usePocketSession } from '../state/PocketSessionProvider';
import { theme } from '../lib/theme';
import { Screen, Muted, NavRow, SectionHeader } from '../components/ui';
import type { Route } from '../navigation';

/**
 * HOME → CLIENTE → CREDENCIALES/URLs → DETALLE is the normal navigation
 * hierarchy: a client is a navigable container (a whole row, tappable),
 * never a filter chip. Global search is the deliberate fast-path that
 * skips that hierarchy entirely — typing a query surfaces matching
 * clients, credentials, AND urls directly, each of which opens straight to
 * its own detail/client screen.
 *
 * Plain ScrollView + .map(), not FlatList: Pocket's realistic data size
 * (a handful of clients, a few dozen credentials at most) makes
 * virtualization unnecessary, and it sidesteps the "VirtualizedLists
 * should never be nested" trap a FlatList-of-clients next to a
 * FlatList-of-results would otherwise risk.
 */
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
  const searching = query.trim().length > 0;

  const credentialCountByClient = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of payload.credentials) map.set(c.clientId, (map.get(c.clientId) ?? 0) + 1);
    return map;
  }, [payload.credentials]);
  const urlCountByClient = useMemo(() => {
    const map = new Map<string, number>();
    for (const u of payload.urls) map.set(u.clientId, (map.get(u.clientId) ?? 0) + 1);
    return map;
  }, [payload.urls]);

  return (
    <Screen scroll contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        {/* The real Arkode lockup (same asset Desktop's own sidebar uses) —
            preferred over a plain "Arkode Pocket" text label, per direct
            request. Home is the only screen carrying the brand mark; every
            other screen keeps its own plain back-link/title. */}
        <Image
          source={require('../../assets/arkode-logo-completo.png')}
          style={{ width: 120, height: 28 }}
          resizeMode="contain"
          accessibilityLabel="Arkode"
        />
        <Pressable onPress={() => onNavigate({ name: 'settings' })} hitSlop={12}>
          <Ionicons name="settings-outline" size={24} color={theme.muted} />
        </Pressable>
      </View>

      <TextInput
        placeholder="Buscar en Arkode…"
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

      <Pressable onPress={() => void refreshNow()} style={{ marginBottom: 8 }}>
        <Text style={{ color: bannerColor, fontSize: 13 }}>{refreshing ? 'Actualizando…' : banner.label} · tocá para actualizar</Text>
      </Pressable>

      {!searching && (
        <>
          <SectionHeader title="CLIENTES" count={results.clients.length} />
          {results.clients.length === 0 && <Muted>No hay clientes con contenido en esta publicación.</Muted>}
          {results.clients.map((c) => (
            <NavRow
              key={c.id}
              icon="business-outline"
              title={c.name}
              subtitle={`${credentialCountByClient.get(c.id) ?? 0} credenciales · ${urlCountByClient.get(c.id) ?? 0} URLs`}
              onPress={() => onNavigate({ name: 'client', clientId: c.id })}
            />
          ))}
        </>
      )}

      {searching && (
        <>
          {results.clients.length > 0 && (
            <>
              <SectionHeader title="CLIENTES" />
              {results.clients.map((c) => (
                <NavRow key={c.id} icon="business-outline" title={c.name} onPress={() => onNavigate({ name: 'client', clientId: c.id })} />
              ))}
            </>
          )}

          {results.credentials.length > 0 && (
            <>
              <SectionHeader title="CREDENCIALES" />
              {results.credentials.map(({ credential, clientName }) => (
                <NavRow
                  key={credential.id}
                  icon={credentialKindIcon(credential.kind)}
                  title={credential.name}
                  subtitle={`${clientName} · ${credentialKindLabel(credential.kind)}`}
                  onPress={() => onNavigate({ name: 'credential', credentialId: credential.id })}
                />
              ))}
            </>
          )}

          {results.urls.length > 0 && (
            <>
              <SectionHeader title="URLs" />
              {results.urls.map(({ url, clientName }) => (
                <NavRow key={url.id} icon="link-outline" title={url.name} subtitle={clientName} onPress={() => onNavigate({ name: 'url', urlId: url.id })} />
              ))}
            </>
          )}

          {results.clients.length === 0 && results.credentials.length === 0 && results.urls.length === 0 && (
            <Muted>No se encontraron resultados.</Muted>
          )}
        </>
      )}
    </Screen>
  );
}
