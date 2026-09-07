import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../lib/theme';
import { copyWithAutoClear } from '../lib/clipboardAutoClear';

/**
 * One labeled value with a copy action. `secret` fields render masked by
 * default with an explicit "reveal" toggle — never shown automatically,
 * never logged either way (this component performs no logging of any kind).
 * Copying never requires revealing first.
 *
 * Ionicons (outline family) over repeated "Copiar"/"Mostrar" text — these
 * two actions are universally recognizable, so a copy glyph + an eye glyph
 * carry the same meaning with far less visual noise across a long list of
 * fields. Rendered in `theme.muted` — deliberately more subdued than the
 * field's own value text, since these are actions, not content. Touch
 * target stays ~44px via padding even though the glyph itself is ~20px.
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
        <View style={{ flexDirection: 'row' }}>
          {secret && (
            <Pressable
              onPress={() => setRevealed((r) => !r)}
              hitSlop={10}
              style={{ padding: 11 }}
              accessibilityLabel={revealed ? 'Ocultar' : 'Mostrar'}
            >
              <Ionicons name={revealed ? 'eye-off-outline' : 'eye-outline'} size={20} color={theme.muted} />
            </Pressable>
          )}
          <Pressable
            onPress={async () => {
              await copyWithAutoClear(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            hitSlop={10}
            style={{ padding: 11 }}
            accessibilityLabel="Copiar"
          >
            <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={20} color={copied ? theme.success : theme.muted} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
