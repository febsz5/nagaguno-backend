// routes/kyc.js
const express = require('express');
const { ageFromBirthdate } = require('../utils/ageFromBirthdate');
const path    = require('path');
const multer  = require('multer');
const { queryAsUser, withTransaction } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadFile, getSignedUrl } = require('../utils/storageService');

const router = express.Router();
router.use(authenticate);

const KYC_BUCKET = 'kyc-documents'; // private bucket — never served via public URL

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|webp/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Images only'), ok);
  },
});

const ID_TYPES = new Set([
  'philsys_national_id',
  'drivers_license',
  'passport',
  'voters_id',
  'barangay_id_with_certification',
]);
const PH_PHONE_REGEX = /^(\+63|0)9\d{9}$/;

const STATUS_MESSAGES = {
  pending: 'Your verification is currently under review. This typically takes 1-2 business days. You may browse the marketplace, but selling and purchasing remain locked until verification is complete.',
  approved: 'Your identity has been verified. You now have full access to list, buy, and sell on NagaGuno.',
  rejected: 'Your verification could not be approved. Please review the reason below and resubmit your information and a valid ID.',
};

async function notify(client, { userId, type, title, message }) {
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message) VALUES ($1, $2, $3, $4)`,
    [userId, type, title, message]
  );
}

// POST /api/kyc/submit
router.post(
  '/submit',
  upload.fields([
    { name: 'id_front', maxCount: 1 },
    { name: 'id_back', maxCount: 1 },
    { name: 'supporting_doc', maxCount: 1 },
    { name: 'liveness_photo', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { id: userId } = req.user;
      const { date_of_birth, complete_address, contact_number, id_type } = req.body;

      const errors = {};
      const ageNum = ageFromBirthdate(date_of_birth);
      if (ageNum === null) errors.date_of_birth = 'Enter a valid date of birth.';
      else if (ageNum < 18 || ageNum > 120) errors.date_of_birth = 'Your date of birth must indicate an age between 18 and 120.';
      if (!complete_address || complete_address.trim().length < 8)
        errors.complete_address = 'Enter your complete address (house/lot no., street, barangay, city).';
      if (!contact_number || !PH_PHONE_REGEX.test(contact_number))
        errors.contact_number = 'Enter a valid Philippine mobile number, e.g. 09123456789.';
      if (!id_type || !ID_TYPES.has(id_type)) errors.id_type = 'Select a valid ID type.';
      if (!req.files?.id_front?.[0]) errors.id_front = 'A front image of a valid ID is required.';
      if (!req.files?.liveness_photo?.[0]) errors.liveness_photo = 'A liveness check is required to submit your ID.';

      if (Object.keys(errors).length) {
        return res.status(400).json({ success: false, message: 'Please fix the highlighted fields.', errors });
      }

      const { rows: existingRows } = await queryAsUser(req.user,
        `SELECT id, status FROM kyc_submissions WHERE user_id = $1`,
        [userId]
      );
      if (existingRows.length && existingRows[0].status === 'approved') {
        return res.status(409).json({ success: false, message: 'Your account is already verified.' });
      }

      const idFrontPath = await uploadFile(
        KYC_BUCKET, `${userId}/id-front-${Date.now()}${path.extname(req.files.id_front[0].originalname)}`,
        req.files.id_front[0].buffer, req.files.id_front[0].mimetype
      );
      const idBackPath = req.files.id_back?.[0]
        ? await uploadFile(KYC_BUCKET, `${userId}/id-back-${Date.now()}${path.extname(req.files.id_back[0].originalname)}`,
            req.files.id_back[0].buffer, req.files.id_back[0].mimetype)
        : null;
      const supportingDocPath = req.files.supporting_doc?.[0]
        ? await uploadFile(KYC_BUCKET, `${userId}/supporting-${Date.now()}${path.extname(req.files.supporting_doc[0].originalname)}`,
            req.files.supporting_doc[0].buffer, req.files.supporting_doc[0].mimetype)
        : null;
      const livenessPhotoPath = await uploadFile(
        KYC_BUCKET, `${userId}/liveness-${Date.now()}${path.extname(req.files.liveness_photo[0].originalname)}`,
        req.files.liveness_photo[0].buffer, req.files.liveness_photo[0].mimetype
      );

      const result = await withTransaction(async (client) => {
        let submission;
        if (existingRows.length) {
          const { rows } = await client.query(
            `UPDATE kyc_submissions
             SET age=$1, date_of_birth=$2, complete_address=$3, contact_number=$4, id_type=$5,
                 id_front_url=$6, id_back_url=$7, supporting_doc_url=$8,
                 liveness_photo_url=$9, liveness_verified_at=NOW(),
                 status='pending', rejection_reason=NULL, reviewed_by=NULL, reviewed_at=NULL,
                 submitted_at=NOW()
             WHERE id=$10 RETURNING *`,
            [ageNum, date_of_birth, complete_address, contact_number, id_type,
             idFrontPath, idBackPath, supportingDocPath, livenessPhotoPath, existingRows[0].id]
          );
          submission = rows[0];
        } else {
          const { rows } = await client.query(
            `INSERT INTO kyc_submissions
               (user_id, age, date_of_birth, complete_address, contact_number, id_type,
                id_front_url, id_back_url, supporting_doc_url, liveness_photo_url, liveness_verified_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *`,
            [userId, ageNum, date_of_birth, complete_address, contact_number, id_type,
             idFrontPath, idBackPath, supportingDocPath, livenessPhotoPath]
          );
          submission = rows[0];
        }

        await notify(client, {
          userId,
          type: 'kyc_submitted',
          title: 'Verification submitted',
          message: STATUS_MESSAGES.pending,
        });

        return submission;
      });

      res.status(201).json({ success: true, data: result, message: 'Verification submitted.' });
    } catch (err) {
      console.error('POST /kyc/submit', err);
      res.status(500).json({ success: false, message: 'Failed to submit verification.' });
    }
  }
);

// GET /api/kyc/me
router.get('/me', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user,
      `SELECT status, rejection_reason, submitted_at, reviewed_at
       FROM kyc_submissions WHERE user_id = $1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.json({ success: true, data: { submitted: false, status: null, message: 'You have not submitted identity verification yet.' } });
    }
    const s = rows[0];
    res.json({
      success: true,
      data: {
        submitted: true,
        status: s.status,
        message: s.status === 'rejected' && s.rejection_reason
          ? `${STATUS_MESSAGES.rejected} Reason: ${s.rejection_reason}`
          : STATUS_MESSAGES[s.status],
        submitted_at: s.submitted_at,
        reviewed_at: s.reviewed_at,
      },
    });
  } catch (err) {
    console.error('GET /kyc/me', err);
    res.status(500).json({ success: false, message: 'Failed to load verification status.' });
  }
});

// GET /api/kyc/queue — admin
router.get('/queue', authorize('admin'), async (req, res) => {
  try {
    const { status = 'pending', limit = 20, offset = 0 } = req.query;
    const { rows } = await queryAsUser(req.user,
      `SELECT k.id, k.user_id, k.status, k.submitted_at,
              u.full_name, u.role, u.barangay
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       WHERE k.status = $1
       ORDER BY k.submitted_at ASC
       LIMIT $2 OFFSET $3`,
      [status, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /kyc/queue', err);
    res.status(500).json({ success: false, message: 'Failed to load KYC queue.' });
  }
});

// GET /api/kyc/:id — admin detail, with short-lived signed document URLs
router.get('/:id', authorize('admin'), async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user,
      `SELECT k.*, u.full_name, u.role, u.barangay, u.phone_number, u.email
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       WHERE k.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'KYC submission not found.' });

    const s = rows[0];
    const [idFrontUrl, idBackUrl, supportingDocUrl, livenessPhotoUrl] = await Promise.all([
      getSignedUrl(KYC_BUCKET, s.id_front_url),
      getSignedUrl(KYC_BUCKET, s.id_back_url),
      getSignedUrl(KYC_BUCKET, s.supporting_doc_url),
      getSignedUrl(KYC_BUCKET, s.liveness_photo_url),
    ]);

    res.json({ success: true, data: { ...s, id_front_url: idFrontUrl, id_back_url: idBackUrl, supporting_doc_url: supportingDocUrl, liveness_photo_url: livenessPhotoUrl } });
  } catch (err) {
    console.error('GET /kyc/:id', err);
    res.status(500).json({ success: false, message: 'Failed to load submission.' });
  }
});

// POST /api/kyc/:id/decision — admin approve/reject
router.post('/:id/decision', authorize('admin'), async (req, res) => {
  try {
    const { decision, rejection_reason } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'." });
    }
    if (decision === 'rejected' && !rejection_reason) {
      return res.status(400).json({ success: false, message: 'A rejection reason is required when rejecting a submission.' });
    }

    const { rows: subRows } = await queryAsUser(req.user, `SELECT * FROM kyc_submissions WHERE id = $1`, [req.params.id]);
    if (!subRows.length) return res.status(404).json({ success: false, message: 'KYC submission not found.' });
    const submission = subRows[0];

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE kyc_submissions
         SET status=$1, rejection_reason=$2, reviewed_by=$3, reviewed_at=NOW()
         WHERE id=$4 RETURNING *`,
        [decision, decision === 'rejected' ? rejection_reason : null, req.user.id, req.params.id]
      );

      if (decision === 'approved') {
        await client.query(
          `UPDATE users SET account_status = 'active' WHERE id = $1 AND account_status = 'pending_verification'`,
          [submission.user_id]
        );
        await notify(client, {
          userId: submission.user_id,
          type: 'kyc_approved',
          title: "You're verified!",
          message: STATUS_MESSAGES.approved,
        });
      } else {
        await notify(client, {
          userId: submission.user_id,
          type: 'kyc_rejected',
          title: 'Verification could not be approved',
          message: `${STATUS_MESSAGES.rejected} Reason: ${rejection_reason}`,
        });
      }

      return rows[0];
    });

    res.json({ success: true, data: result, message: `KYC submission ${decision}.` });
  } catch (err) {
    console.error('POST /kyc/:id/decision', err);
    res.status(500).json({ success: false, message: 'Failed to record decision.' });
  }
});

module.exports = router;
