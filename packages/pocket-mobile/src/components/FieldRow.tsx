import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { theme } from '../lib/theme';
import { copyWithAutoClear } from '../lib/clipboardAutoClear';

/**
 * One labeled value with a copy action. `secret` fields render masked by
 * default with an explicit "reveal" toggle — never shown automatically,
 * never logged either way (this component performs no logging of any kind).
 * Copying never requires revealing first.
 *
 * Icons over repeated "Copiar"/"Mostrar" text per the UX pass — these two
 * actions are universally recognizable, so a clipboard glyph + an eye glyph
 * carry the same meaning with far less visual noise across a long list of
 * fields. The eye toggle intentionally uses 👁/🔒 rather than a
 * conventional "eye-off" glyph (no clean monochrome equivalent exists) —
 * 👁 = hidden, tap to reveal; 🔒 = currently shown, tap to hide again.
 */
export function FieldRow({ label, value, secret = false }: { label: string; value: string | number | null; secret?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  if (value === null || value === '') return null;
  const text = String(value);
  const display = secret && !revealed ? '••••••••' : text;

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.border, paddingVertical: 10 }}>
      <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 2 }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: theme.text, fontSize: 15, flex: 1, marginRight: 8 }} selectable={!secret || revealed}>
          {display}
        </Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {secret && (
            <Pressable
              onPress={() => setRevealed((r) => !r)}
              hitSlop={10}
              style={{ paddingHorizontal: 8, paddingVertical: 6 }}
              accessibilityLabel={revealed ? 'Ocultar' : 'Mostrar'}
            >
              <Text style={{ fontSize: 17 }}>{revealed ? '🔒' : '👁'}</Text>
            </Pressable>
          )}
          <Pressable
            onPress={async () => {
              await copyWithAutoClear(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            hitSlop={10}
            style={{ paddingHorizontal: 8, paddingVertical: 6 }}
            accessibilityLabel="Copiar"
          >
            <Text style={{ fontSize: 17 }}>{copied ? '✅' : '📋'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
