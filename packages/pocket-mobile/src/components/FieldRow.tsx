import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { theme } from '../lib/theme';
import { copyWithAutoClear } from '../lib/clipboardAutoClear';

/**
 * One labeled value with a copy action. `secret` fields render masked by
 * default with an explicit "mostrar" toggle — never shown automatically,
 * never logged either way (this component performs no logging of any kind).
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
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {secret && (
            <Pressable onPress={() => setRevealed((r) => !r)}>
              <Text style={{ color: theme.accent, fontSize: 13 }}>{revealed ? 'Ocultar' : 'Mostrar'}</Text>
            </Pressable>
          )}
          <Pressable
            onPress={async () => {
              await copyWithAutoClear(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Text style={{ color: theme.accent, fontSize: 13 }}>{copied ? 'Copiado ✓' : 'Copiar'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
