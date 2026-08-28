import { describe, expect, it } from 'vitest';
import { isMariaDbBinary, mysqlFamilySslArgs } from '../../src/databaseConnections/mysqlClientResolution.js';

describe('isMariaDbBinary', () => {
  it('recognises the MariaDB client and dumper by basename', () => {
    expect(isMariaDbBinary('C:\\Program Files\\arkode\\resources\\mariadb\\mariadb.exe')).toBe(true);
    expect(isMariaDbBinary('C:\\x\\mariadb-dump.exe')).toBe(true);
    expect(isMariaDbBinary('/opt/mariadb')).toBe(true);
  });

  it('does not misclassify the MySQL tools', () => {
    expect(isMariaDbBinary('D:\\wamp64\\bin\\mysql\\mysql9.1.0\\bin\\mysql.exe')).toBe(false);
    expect(isMariaDbBinary('C:\\x\\mysqldump.exe')).toBe(false);
  });
});

describe('mysqlFamilySslArgs', () => {
  it('emits MySQL --ssl-mode syntax for the mysql flavor', () => {
    expect(mysqlFamilySslArgs('mysql', 'disable')).toEqual(['--ssl-mode=DISABLED']);
    expect(mysqlFamilySslArgs('mysql', 'require')).toEqual(['--ssl-mode=REQUIRED']);
    expect(mysqlFamilySslArgs('mysql', 'verify-full')).toEqual(['--ssl-mode=VERIFY_IDENTITY']);
  });

  it('emits the boolean --ssl / --skip-ssl syntax for the mariadb flavor (no --ssl-mode)', () => {
    expect(mysqlFamilySslArgs('mariadb', 'disable')).toEqual(['--skip-ssl']);
    expect(mysqlFamilySslArgs('mariadb', 'require')).toEqual(['--ssl']);
    expect(mysqlFamilySslArgs('mariadb', 'verify-full')).toEqual(['--ssl', '--ssl-verify-server-cert']);
  });

  it('emits nothing when no sslMode is set, for either flavor', () => {
    expect(mysqlFamilySslArgs('mysql', undefined)).toEqual([]);
    expect(mysqlFamilySslArgs('mariadb', null)).toEqual([]);
  });
});
