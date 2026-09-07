import { useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';
import Constants from 'expo-constants';
import { deviceLooksCompromised } from '../lib/rootDetection';
import { usePocketSession } from '../state/PocketSessionProvider';
import { signOutOfGoogle } from '../auth/googleAuth';
import { AppButton, BackLink, Card, Muted, Screen, Title } from '../components/ui';
import { theme } from '../lib/theme';

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { forgetDevice } = usePocketSession();
  const [compromised, setCompromised] = useState(false);

  useEffect(() => {
    setCompromised(deviceLooksCompromised());
  }, []);

  return (
    <Screen scroll>
      <BackLink label="Volver" onPress={onBack} />
      <Title>Configuración</Title>

      {compromised && (
        <Card style={{ borderColor: theme.warning, marginBottom: 16 }}>
          <Text style={{ color: theme.warning }}>
            Este dispositivo parece tener protecciones del sistema modificadas. Las credenciales pueden estar menos
            protegidas.
          </Text>
        </Card>
      )}

      <Card style={{ marginBottom: 16 }}>
        <Muted>
          Arkode Pocket es de solo lectura. Arkode Desktop es la única fuente de verdad — nada de lo que hagas acá se
          escribe de vuelta.
        </Muted>
      </Card>

      <AppButton
        title="Olvidar este dispositivo"
        variant="danger"
        onPress={() =>
          Alert.alert(
            'Olvidar este dispositivo',
            'Se borra la clave y la copia local de este teléfono. Esto NO revoca el dispositivo desde Arkode Desktop — si querés impedir que vuelva a sincronizar, revocalo también desde ahí.',
            [
              { text: 'Cancelar', style: 'cancel' },
              {
                text: 'Olvidar',
                style: 'destructive',
                onPress: () => {
                  void signOutOfGoogle().catch(() => {});
                  void forgetDevice();
                },
              },
            ]
          )
        }
      />

      <Text style={{ color: theme.muted, fontSize: 12, marginTop: 24, textAlign: 'center' }}>
        Arkode Pocket {Constants.expoConfig?.version ?? ''}
      </Text>
    </Screen>
  );
}
