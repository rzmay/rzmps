import loadHdri from 'examples/utils/hdri.js';
import environment from 'examples/assets/images/shanghai_bund_1k.hdr?url';

const shanghaiBundScene = loadHdri(environment);
shanghaiBundScene.metadata = {
  'id': 'shanghaiBund',
  'title': 'Shanghai Bund HDRI',
  'author': 'rzmay'
};
export default shanghaiBundScene;
