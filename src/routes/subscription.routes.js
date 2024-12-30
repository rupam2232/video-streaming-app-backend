import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {optionalVerifyJWT} from "../middlewares/optionalAuth.middleware.js"
import { toggleSubscription, getUserChannelSubscribers, getSubscribedChannels, isSubscribed } from "../controllers/subscription.controller.js";

const router = Router()
// router.use(verifyJWT)

router.route("/c/:channelId").post(verifyJWT, toggleSubscription).get(verifyJWT, getSubscribedChannels)
router.route("/u/:channelId").get(optionalVerifyJWT, getUserChannelSubscribers)
router.route("/i/:channelId").get(optionalVerifyJWT, isSubscribed)

export default router