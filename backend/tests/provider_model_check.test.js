const test = require('node:test');
const assert = require('node:assert');
const { missingModels } = require('../src/services/providerModelCheck');

test('text model absent from text entries is missing', () => {
  assert.deepEqual(missingModels({ modality: 'text', model: 'a' }, [{ kind: 'text', id: 'b' }]), ['a']);
  assert.deepEqual(missingModels({ modality: 'text', model: 'b' }, [{ kind: 'text', id: 'b' }]), []);
});
test('blank image_edit and sprite models are always fine', () => {
  assert.deepEqual(missingModels({ modality: 'image_edit', model: '' }, []), []);
  assert.deepEqual(missingModels({ modality: 'image_edit', model: '' }, [{ kind: 'image_edit', id: 'x' }]), []);
  assert.deepEqual(missingModels({ modality: 'sprite', model: '' }, [{ kind: 'sprite', id: 'q' }]), []);
});
test('audio checks every non-empty models_by_group value', () => {
  const p = { modality: 'audio', models_by_group: { music: 'audio:x', ambience: '' } };
  assert.deepEqual(missingModels(p, [{ kind: 'audio', id: 'audio:y' }]), ['audio:x']);
  assert.deepEqual(missingModels(p, [{ kind: 'audio', id: 'audio:x' }]), []);
});
test('no entries of the provider kind means cannot judge', () => {
  const p = { modality: 'audio', models_by_group: { music: 'audio:x' } };
  assert.deepEqual(missingModels(p, [{ kind: 'text', id: 't' }]), []);
  assert.deepEqual(missingModels({ modality: 'text', model: 'a' }, []), []);
});
test('image is not checked', () => {
  assert.deepEqual(missingModels({ modality: 'image', model: 'a' }, [{ kind: 'image', id: 'b' }]), []);
});
