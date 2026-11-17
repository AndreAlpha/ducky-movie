const { setTimeout: delay } = require('node:timers/promises');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const packager = context.packager;
  const editResources = packager.signAndEditResources.bind(packager);
  // Windows can briefly lock a newly written executable while inspecting it.
  // Retry the resource edit on the same output, preserving the normal builder flow.
  packager.signAndEditResources = async (...args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await editResources(...args);
      } catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || attempt >= 9)
          throw error;
        await delay(1500);
      }
    }
  };
};
