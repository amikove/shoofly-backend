// ── Moteur de stockage multer → Cloudinary, en interne ──────
// Remplace le package multer-storage-cloudinary : ses 5 versions publiées sont TOUTES
// verrouillées sur cloudinary ^1.21.0 (peerDependency), donc incompatibles avec le correctif
// de sécurité cloudinary 2.10.0 (CVE-2025-12613 / GHSA-g4mf-96x5-5m2c, CVSS 8.6). Cette
// réimplémentation reproduit fidèlement le comportement du package original (lu directement
// dans node_modules/multer-storage-cloudinary/lib/index.js avant remplacement) en appelant
// directement cloudinary.uploader.upload_stream/.destroy — des méthodes stables du SDK,
// inchangées entre v1.x et v2.x. Ne supporte que la forme `params` utilisée par les 3 routes
// d'upload du projet (fonction async (req, file) => options), pas la forme objet du package
// original (jamais utilisée ici) — voir RAPPORT_VERDICT_LANCEMENT.md.
function createCloudinaryStorage({ cloudinary, params }) {
  if (!cloudinary) throw new Error('cloudinary requis');
  if (typeof params !== 'function') throw new Error('params doit être une fonction (req, file) => options');

  return {
    async _handleFile(req, file, callback) {
      try {
        const uploadOptions = await params(req, file);
        const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, (err, result) => {
          if (err) return callback(err);
          callback(null, { path: result.secure_url, size: result.bytes, filename: result.public_id });
        });
        file.stream.pipe(uploadStream);
      } catch (err) {
        callback(err);
      }
    },
    _removeFile(req, file, callback) {
      cloudinary.uploader.destroy(file.filename, { invalidate: true }, callback);
    },
  };
}

module.exports = { CloudinaryStorage: createCloudinaryStorage };
