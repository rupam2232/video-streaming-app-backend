import { asyncHandler } from "../utils/asyncHandler.js"
import { ApiError } from "../utils/ApiError.js"
import { User } from "../models/user.model.js"
import { Video } from "../models/video.model.js"
import cloudinary  from "../utils/cloudinary.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import jwt from "jsonwebtoken"
import mongoose, { isValidObjectId } from "mongoose"
import fs from "fs"

const generateAccessAndRefreshTokens = async (userId) => {
    try {
        const user = await User.findById(userId)
        const accessToken = await user.generateAccessToken()
        const refreshToken = await user.generateRefreshToken()

        user.refreshToken = refreshToken
        await user.save({ validateBeforeSave: false })

        return { accessToken, refreshToken }

    } catch (error) {
        throw new ApiError(500, "Something went wrong")
    }
}

const registerUser = asyncHandler(async (req, res) => {

    const { fullName, email, password, username, otp } = req.body

    if (
        [fullName, email, password, username, otp].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required")
    }

    if( req.verifyOtp !== true ) throw new ApiError(400, "Invalid otp")

    const existedUser = await User.findOne({
        $or: [{ username }, { email }]
    })

    if (existedUser) {
        throw new ApiError(409, "User with email or username already exists")
    }

    const user = await User.create({
        fullName,
        email,
        password,
        username: username.toLowerCase()
    })

    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    )

    if (!createdUser) {

        throw new ApiError(500, "Something went wrong while registering the user")
    }

    return res.status(201).json(
        new ApiResponse(200, createdUser, "User registered Successfully")
    )

})

const loginUser = asyncHandler(async (req, res) => {
    const { username, email, password } = req.body
    
    if (!(username || email)) throw new ApiError(400, "username or email is required")

    const user = await User.findOne({
        $or: [{ username }, { email }]
    })

    if (!user) throw new ApiError(404, "Invalid user credentials")

    const isPasswordValid = await user.isPasswordCorrect(password)

    if (!isPasswordValid) throw new ApiError(404, "Invalid user credentials")

    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken")
    
    const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
    }

    return res
        .status(200)
        .cookie("accessToken", accessToken, {...options, maxAge : 3 * 24 * 60 * 60 * 1000})
        .cookie("refreshToken", refreshToken, {...options, maxAge : 10 * 24 * 60 * 60 * 1000})
        .json(
            new ApiResponse(
                200,
                {
                    user: loggedInUser,
                },
                "user logged In Successfully"
            )
        )

})

const logoutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: {
                refreshToken: 1
            }
        },
        {
            new: true
        }
    )

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "User logged Out"))
})

const refreshAccessToken = asyncHandler(async (req, res) => {
    try {
        const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken

        if (!incomingRefreshToken) throw new ApiError(401, "Unauthorized request")

        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        )

        const user = await User.findById(decodedToken?._id)

        if (!user) throw new ApiError(401, "Invalid refresh token")

        if (incomingRefreshToken !== user?.refreshToken) throw new ApiError(401, "Refresh token is expired or used")

        const options = {
            httpOnly: true,
            secure: true
        }

        const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id)

        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", refreshToken, options)
            .json(
                new ApiResponse(
                    200,
                    { accessToken, refreshToken },
                    "Access token refreshed"
                )
            )
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid refresh token")
    }
})

const changeCurrentPassword = asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body

    if(!(oldPassword && newPassword)) throw new ApiError(400, "old and new both passwords are required")
    const user = await User.findById(req.user?._id)

    const isPasswordCorrect = await user.isPasswordCorrect(oldPassword)

    const isNewPasswordSame = await user.isPasswordCorrect(newPassword)

    if (!isPasswordCorrect) throw new ApiError(400, "Invalid old password")
    if (isNewPasswordSame) throw new ApiError(400, "Old password and New password are same")

    user.password = newPassword
    await user.save({ validateBeforeSave: false })

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Password changed successfully"))
})

const getCurrentUser = asyncHandler(async (req, res) => {
    return res
        .status(200)
        .json(new ApiResponse(200, req.user, "current user fetched successfully"))
})

const updateAccountDetails = asyncHandler(async (req, res) => {
    const { fullName, email } = req.body

    if (!fullName || !email) throw new ApiError(400, "All fields are required")

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                fullName,
                email
            }
        },
        { new: true }
    ).select("-password")

    return res
        .status(200)
        .json(new ApiResponse(200, user, "Account details updated successfully"))
})

const updateUserAvatar = asyncHandler(async (req, res) => {
    const avatarLocalPath = req.file?.path

    if (!avatarLocalPath) throw new ApiError(400, "Avatar file is missing")
    if (! req.file.mimetype.includes("image")){
        fs.unlinkSync(req.file.path)
         throw new ApiError(400, "Only images are allowed to upload")
        }

    const avatar = await cloudinary.upload(avatarLocalPath, "videotube/users")

    if (!avatar.secure_url) throw new ApiError(500, "Error while uploading avatar")

    const oldUser = await User.findById(req.user?.id)
    await cloudinary.delete(oldUser.avatar)

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                avatar: avatar.secure_url
            }
        },
        { new: ture }
    ).select("-password")

    return res
        .status(200)
        .json(
            new ApiResponse(200, user, "Avatar updated successfully")
        )
})

const updateUserCoverImage = asyncHandler(async (req, res) => {
    const coverImageLocalPath = req.file?.path

    if (!coverImageLocalPath) throw new ApiError(400, "Cover file is missing")
    if (req.file.mimetype.includes("gif") || !req.file.mimetype.includes("image")){ 
        fs.unlinkSync(req.file.path)
        throw new ApiError(400, "Only images are allowed to upload")
    }

    const coverImage = await cloudinary.upload(coverImageLocalPath, "videotube/users")

    if (!coverImage.secure_url) throw new ApiError(500, "Error while uploading cover image")

    const oldUser = await User.findById(req.user?.id)
    if(oldUser?.coverImage) await cloudinary.delete(oldUser.coverImage)

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                coverImage: coverImage.secure_url
            }
        },
        { new: true }
    ).select("-password")

    return res
        .status(200)
        .json(
            new ApiResponse(200, user, "coverImage updated successfully")
        )
})

const getUserChannelProfile = asyncHandler(async (req, res) => {
    const { username } = req.params

    if (!username?.trim()) throw new ApiError(400, "username is missing")

    const channel = await User.aggregate([
        {
            $match: {
                username: username?.toLowerCase()
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",
                as: "subscribers"
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "subscriber",
                as: "subscribedTo"
            }
        },
        {
            $addFields: {
                subscribersCount: {
                    $size: "$subscribers"
                },
                channelsSubscibedToCount: {
                    $size: "$subscribedTo"
                },
                isSubscribed: {
                    $cond: {
                        if: { $in: [req.user?._id, "$subscribers.subscriber"] },
                        then: true,
                        else: false
                    }
                }
            }
        },
        {
            $project: {
                fullName: 1,
                username: 1,
                subscribersCount: 1,
                channelsSubscibedToCount: 1,
                isSubscribed: 1,
                avatar: 1,
                coverImage: 1,
                email: 1,
                verified: 1,
                createdAt: 1

            }
        }
    ])

    if (!channel?.length) throw new ApiError(404, "channel does not exists")

    return res
        .status(200)
        .json(
            new ApiResponse(200, channel[0], "User channel fetched successfully")
        )
})

const getWatchHistory = asyncHandler(async (req, res) => {

    const findUser = await User.findById(req.user._id)
    if (!findUser) throw new ApiError(404, "User does not exists")

    const page = parseInt(req.query.page, 10) || 1; 
    const limit = parseInt(req.query.limit, 10) || 10; 
    if (page < 1 || limit < 1) {
        return res
            .status(400)
            .json(new ApiResponse(400, 'Page and limit must be positive integers'));
    }
    const skip = (page - 1) * limit;

    const user = await User.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(req.user._id)
            }
        },{
            $project: {
                watchHistory: { $reverseArray: "$watchHistory" }, // Reverse the array to get the desired order
            },
        },{
            $unwind: "$watchHistory"
        },{
            $lookup: {
                from: "videos",
                localField: "watchHistory",
                foreignField: "_id",
                as: "watchHistory",
                pipeline: [
                    {
                        $match: {isPublished: true}
                    },{
                        $sort: {createdAt: -1}
                    },
                    {
                        $lookup: {
                            from: "users",
                            localField: "owner",
                            foreignField: "_id",
                            as: "owner",
                            pipeline: [
                                {
                                    $project: {
                                        _id: 1,
                                        fullName: 1,
                                        username: 1,
                                        avatar: 1,
                                        verified: 1
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields: {
                            owner: {
                                $first: "$owner"
                            }
                        }
                    },{
                        $project: {
                            _id: 1,
                            thumbnail: 1,
                            title: 1,
                            duration: 1,
                            views: 1,
                            isPublished: 1,
                            owner: 1
                        }
                    }
                ]
            }
        },{
            $unwind: "$watchHistory"
        },{
            $replaceRoot: { newRoot: "$watchHistory" }, // Replace root with video documents
        },{
            $skip: skip, 
        },{
            $limit: limit,
        },{
            $group: {
                _id: null,
                watchHistory: { $push: "$$ROOT" }
                }
        }
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(200, user[0]?.watchHistory || [], "Watch history fetched successfully")
        )
})

const pushVideoToWatchHistory = asyncHandler(async (req,res)=>{
    const {videoId} = req.params
    if(! isValidObjectId(videoId)) throw new ApiError(400, "video id is not a valid object id")

    const isVideoAvl = await Video.findOne({_id: videoId, isPublished: true})

    if( !isVideoAvl ) throw new ApiError(400, "video not found")

    const user = await User.findByIdAndUpdate(req.user?._id,{
        $push: {watchHistory: isVideoAvl._id},
    },{
        new: true,
        validateBeforeSave: false
    }).select("watchHistory _id username")

    if(! user) throw new ApiError(400, "User not found")

    return res
    .status(200)
    .json(new ApiResponse(200, user, "Video added to watchHistory successfully"))
})

const checkIfUsernameIsAvl = asyncHandler(async (req,res)=>{
    const {username} = req.params

    const user = await User.findOne({username})

    if(user){
        return res
        .status(200)
        .json(new ApiResponse(200, false , `@${username} is unavailable`))
    }else{
        return res
        .status(200)
        .json(new ApiResponse(200, true , `@${username} is available`))
    }
})

const checkIfEmailIsAvl = asyncHandler(async (req,res)=>{
    const {email} = req.params

    const user = await User.findOne({email})

    if(user){
        return res
        .status(200)
        .json(new ApiResponse(200, false , `${email} is already in use`))
    }else{
        return res
        .status(200)
        .json(new ApiResponse(200, true , `${email} is available`))
    }
})

export {
    registerUser,
    loginUser,
    logoutUser,
    refreshAccessToken,
    changeCurrentPassword,
    getCurrentUser,
    updateAccountDetails,
    updateUserAvatar,
    updateUserCoverImage,
    getUserChannelProfile,
    getWatchHistory,
    pushVideoToWatchHistory,
    checkIfUsernameIsAvl,
    checkIfEmailIsAvl
}