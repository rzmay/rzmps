import loadHdri from 'examples/utils/hdri.js';
import environment from 'examples/assets/images/ferndale_studio_11_1k.hdr?url';

const ferndaleStudioScene = loadHdri(environment);
ferndaleStudioScene.metadata = {
  'id': 'ferndaleStudio',
  'title': 'Ferndale Studio HDRI',
  'author': 'rzmay'
};
export default ferndaleStudioScene;
