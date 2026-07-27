'use strict';

const assert = require('assert');
const { describe } = require('./harness');
const protocol = require('../src/protocol');
const v1 = require('../src/protocol/v1');
const v2 = require('../src/protocol/v2');
const translator = require('../src/protocol/translator');

describe('protocol: framing', ({ test }) => {
  test('builds proto 2 request frames by default', () => {
    assert.strictEqual(
      protocol.buildFrame('pwr.snap', '101', { met: 'avg' }),
      'proto=2 type=cmd cmd=pwr.snap req=101 met=avg\r\n',
    );
  });

  test('can build proto 1 request frames for legacy meters', () => {
    assert.strictEqual(
      protocol.buildFrame('pwr.snap', '101', { met: 'avg' }, '1'),
      'proto=1 type=cmd cmd=pwr.snap req=101 met=avg\r\n',
    );
  });

  test('omits empty, null and undefined fields', () => {
    assert.strictEqual(
      protocol.buildFrame('sys.id', '1', { a: '', b: null, c: undefined, d: 0 }),
      'proto=2 type=cmd cmd=sys.id req=1 d=0\r\n',
    );
  });

  test('omits the req token when no request id is supplied', () => {
    assert.strictEqual(
      protocol.buildFrame('sys.id'),
      'proto=2 type=cmd cmd=sys.id\r\n',
    );
  });

  test('preserves field order so cfg.set sends elem before val', () => {
    const fields = protocol.buildConfigSetFields('eval', '250.0', { element: 3 });
    assert.strictEqual(
      protocol.buildFrame('cfg.set', '9', fields),
      'proto=2 type=cmd cmd=cfg.set req=9 key=eval elem=3 val=250.0\r\n',
    );
  });

  test('rejects element-scoped cfg.set without a valid element', () => {
    assert.throws(() => protocol.buildConfigSetFields('etype', '30ua'), /requires an element/);
    assert.throws(() => protocol.buildConfigSetFields('eval', '1', { element: 9 }), /requires an element/);
  });

  test('falls back to proto 2 for unsupported versions', () => {
    assert.strictEqual(
      protocol.buildFrame('sys.id', '1', {}, '7'),
      'proto=2 type=cmd cmd=sys.id req=1\r\n',
    );
  });
});

describe('protocol: parsing', ({ test }) => {
  test('parses a response frame into fields', () => {
    const frame = protocol.parseFrame(
      'proto=2 type=resp status=ok cmd=sys.id req=4 uid=002E dname=DWM_V2',
    );
    assert.strictEqual(frame.proto, '2');
    assert.strictEqual(frame.type, 'resp');
    assert.strictEqual(frame.status, 'ok');
    assert.strictEqual(frame.cmd, 'sys.id');
    assert.strictEqual(frame.req, '4');
    assert.strictEqual(frame.uid, '002E');
    assert.strictEqual(frame.dname, 'DWM_V2');
  });

  test('splits each token on its first equals sign only', () => {
    const frame = protocol.parseFrame('proto=2 msg=a=b=c');
    assert.strictEqual(frame.msg, 'a=b=c');
  });

  test('recognises frame lines and ignores free-form output', () => {
    assert.strictEqual(protocol.isFrameLine('proto=2 type=resp'), true);
    assert.strictEqual(protocol.isFrameLine('Booting DWM V2...'), false);
  });

  test('reassembles lines across chunk boundaries', () => {
    const first = protocol.extractLines('proto=2 a=1\r\nproto=2 b=2\r\npro');
    assert.deepStrictEqual(first.lines, ['proto=2 a=1', 'proto=2 b=2']);
    assert.strictEqual(first.remainder, 'pro');

    const second = protocol.extractLines(`${first.remainder}to=2 c=3\r\n`);
    assert.deepStrictEqual(second.lines, ['proto=2 c=3']);
    assert.strictEqual(second.remainder, '');
  });

  test('accepts proto 1 and proto 2 responses during transition', () => {
    assert.strictEqual(protocol.isSupportedProto('1'), true);
    assert.strictEqual(protocol.isSupportedProto('2'), true);
    assert.strictEqual(protocol.isSupportedProto('3'), false);
  });
});

describe('protocol: errors', ({ test }) => {
  test('describes known error codes', () => {
    assert.strictEqual(
      protocol.describeError({ cmd: 'cfg.set', code: 'ERR_BAD_ENUM' }),
      'cfg.set failed: A key had an unsupported value',
    );
  });

  test('appends the firmware detail when it adds information', () => {
    assert.strictEqual(
      protocol.describeError({
        cmd: 'sys.id',
        code: 'ERR_BAD_ENUM',
        msg: 'unsupported_proto',
      }),
      'sys.id failed: A key had an unsupported value (unsupported_proto)',
    );
  });

  test('falls back gracefully for unknown codes', () => {
    assert.strictEqual(
      protocol.describeError({ cmd: 'x', code: 'ERR_NEW' }),
      'x failed: ERR_NEW',
    );
    assert.strictEqual(
      protocol.describeError({}),
      'command failed: Unknown device error',
    );
  });

  test('builds a ProtocolError carrying the code and frame', () => {
    const error = protocol.toProtocolError({
      cmd: 'cfg.set',
      code: 'ERR_VALUE_RANGE',
      msg: 'bright_out_of_range',
    });
    assert.strictEqual(error.name, 'ProtocolError');
    assert.strictEqual(error.code, 'ERR_VALUE_RANGE');
    assert.strictEqual(error.command, 'cfg.set');
  });
});

describe('protocol: range enumeration', ({ test }) => {
  test('parses textual range values', () => {
    assert.strictEqual(protocol.parseRangeMultiplier('1x'), 1);
    assert.strictEqual(protocol.parseRangeMultiplier('2x'), 2);
    assert.strictEqual(protocol.parseRangeMultiplier('4x'), 4);
  });

  test('parses numeric range values and cfg mappings', () => {
    assert.strictEqual(protocol.parseRangeMultiplier('0'), 1);
    assert.strictEqual(protocol.parseRangeMultiplier('1'), 2);
    assert.strictEqual(protocol.parseRangeMultiplier('2'), 4);
    assert.strictEqual(protocol.parseRangeCfg('0'), 0);
    assert.strictEqual(protocol.parseRangeCfg('1'), 1);
    assert.strictEqual(protocol.parseRangeCfg('2'), 2);
    assert.strictEqual(protocol.parseRangeCfg('1x'), 0);
    assert.strictEqual(protocol.parseRangeCfg('2x'), 1);
    assert.strictEqual(protocol.parseRangeCfg('4x'), 2);
    assert.strictEqual(protocol.cfgToRangeMultiplier(0), 1);
    assert.strictEqual(protocol.cfgToRangeMultiplier(1), 2);
    assert.strictEqual(protocol.cfgToRangeMultiplier(2), 4);
    assert.deepStrictEqual(protocol.normalizeRange('4x'), {
      cfg: 2,
      multiplier: 4,
      label: '4x',
    });
  });

  test('returns null for unparseable range values', () => {
    assert.strictEqual(protocol.parseRangeCfg(''), null);
    assert.strictEqual(protocol.parseRangeCfg('banana'), null);
    assert.strictEqual(protocol.normalizeRange('banana'), null);
  });

  test('v1 and v2 disagree about the config integers', () => {
    assert.strictEqual(v1.rangeCfgToMultiplier(0), 2);
    assert.strictEqual(v1.rangeCfgToMultiplier(1), 4);
    assert.strictEqual(v2.rangeCfgToMultiplier(0), 1);
    assert.strictEqual(v2.rangeCfgToMultiplier(1), 2);
    assert.strictEqual(v2.rangeCfgToMultiplier(2), 4);
  });
});

describe('protocol: v1/v2 translation', ({ test }) => {
  test('encodes the same gain differently per version', () => {
    assert.strictEqual(translator.multiplierToWireRange(4, '2'), 2);
    assert.strictEqual(translator.multiplierToWireRange(4, '1'), 1);
    assert.strictEqual(translator.multiplierToWireRange(2, '2'), 1);
    assert.strictEqual(translator.multiplierToWireRange(2, '1'), 0);
  });

  test('maps 1x to the nearest legacy gain, since v1 has no 1x', () => {
    assert.strictEqual(translator.multiplierToWireRange(1, '1'), 0);
    assert.strictEqual(v1.rangeCfgToMultiplier(0), 2);
  });

  test('decodes wire range integers using the frame version', () => {
    assert.strictEqual(translator.wireRangeToMultiplier('1', '1'), 4);
    assert.strictEqual(translator.wireRangeToMultiplier('1', '2'), 2);
  });

  test('honours textual labels regardless of version', () => {
    assert.strictEqual(translator.wireRangeToMultiplier('4x', '1'), 4);
    assert.strictEqual(translator.wireRangeToMultiplier('4x', '2'), 4);
  });

  test('rewrites cfg.set range values for legacy devices', () => {
    const legacy = translator.translateRequest(
      { command: 'cfg.set', fields: { key: 'range', val: '2' } },
      '1',
    );
    assert.strictEqual(legacy.fields.val, '1');

    const modern = translator.translateRequest(
      { command: 'cfg.set', fields: { key: 'range', val: '2' } },
      '2',
    );
    assert.strictEqual(modern.fields.val, '2');
  });

  test('leaves non-range fields untouched', () => {
    const result = translator.translateRequest(
      { command: 'cfg.set', fields: { key: 'bright', val: '7' } },
      '1',
    );
    assert.deepStrictEqual(result.fields, { key: 'bright', val: '7' });
  });

  test('normalises response ranges to canonical labels', () => {
    assert.strictEqual(
      translator.translateResponse({ proto: '1', range: '1' }).range,
      '4x',
    );
    assert.strictEqual(
      translator.translateResponse({ proto: '2', range: '1' }).range,
      '2x',
    );
  });

  test('normalises cfg.get range values into v2 config integers', () => {
    assert.strictEqual(
      translator.translateResponse({ proto: '1', key: 'range', val: '1' }).val,
      '2',
    );
  });

  test('does not mutate the frame it translates', () => {
    const original = { proto: '1', range: '1' };
    translator.translateResponse(original);
    assert.strictEqual(original.range, '1');
  });

  test('round-trips a gain through both versions', () => {
    ['1', '2'].forEach((version) => {
      [2, 4].forEach((multiplier) => {
        const cfg = translator.multiplierToWireRange(multiplier, version);
        assert.strictEqual(
          translator.wireRangeToMultiplier(String(cfg), version),
          multiplier,
        );
      });
    });
  });
});

describe('protocol: payload decoding', ({ test }) => {
  test('expands the compact pwr.snap CSV into named numeric fields', () => {
    const snapshot = protocol.decodeSnapshot({
      cmd: 'pwr.snap',
      d: '8.044083,8.041705,8.046461,8.053598,8.034575,0.019023,55.69,5.0',
      elem: '1',
      etype: '30ua',
      eval: '5.000',
      range: '4x',
    });

    assert.strictEqual(snapshot.inst, 8.044083);
    assert.strictEqual(snapshot.avg, 8.041705);
    assert.strictEqual(snapshot.peak, 8.046461);
    assert.strictEqual(snapshot.max, 8.053598);
    assert.strictEqual(snapshot.min, 8.034575);
    assert.strictEqual(snapshot.dev, 0.019023);
    assert.strictEqual(snapshot.pvolt, 55.69);
    assert.strictEqual(snapshot.svolt, 5);
    assert.strictEqual(snapshot.elem, 1);
    assert.strictEqual(snapshot.etype, '30ua');
    assert.strictEqual(snapshot.range.multiplier, 4);
    assert.strictEqual(snapshot.maxPowerW, 20);
  });

  test('tolerates a snapshot with no d field', () => {
    const snapshot = protocol.decodeSnapshot({ cmd: 'pwr.snap', eval: '5' });
    assert.strictEqual(snapshot.avg, 0);
    assert.strictEqual(snapshot.eval, 5);
  });

  test('decodes eight element profiles from cfg.elems', () => {
    const frame = { cmd: 'cfg.elems' };
    for (let i = 1; i <= 8; i += 1) {
      frame[`e${i}v`] = String(i * 10);
      frame[`e${i}t`] = i === 3 ? '100UA' : '30ua';
    }

    const profiles = protocol.decodeElementProfiles(frame);
    assert.strictEqual(profiles.length, 8);
    assert.deepStrictEqual(profiles[0], { elem: 1, eval: 10, etype: '30ua' });
    assert.deepStrictEqual(profiles[2], { elem: 3, eval: 30, etype: '100ua' });
  });

  test('defaults missing element profiles rather than dropping them', () => {
    const profiles = protocol.decodeElementProfiles({});
    assert.strictEqual(profiles.length, 8);
    assert.deepStrictEqual(profiles[7], { elem: 8, eval: 0, etype: '30ua' });
  });

  test('splits the sys.cmds list', () => {
    assert.deepStrictEqual(
      protocol.decodeSupportedCommands({ cmds: 'pwr.get,pwr.snap, sys.id ,' }),
      ['pwr.get', 'pwr.snap', 'sys.id'],
    );
    assert.deepStrictEqual(protocol.decodeSupportedCommands({}), []);
  });
});
