const mongoose = require("mongoose");
const PlanOrderSchema = new mongoose.Schema({
    sellerId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Seller",
        required:true
    },
    planId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Plan",
        required:true
    },
    expiryDate:{
        type:Date,
        required:true
    },
    durationDays:{
        type:Number,
        required:true
    },
    price:{
        type:Number,
        required:true
    },
    customerLimit:{
        type:Number,
        default:null
    },
    productLimit:{
        type:Number,
        default:null
    },
    orderLimit:{
        type:Number,
        default:null
    },
    customerCurrentCount:{
        type:Number,
        default:0
    },
    productCurrentCount:{
        type:Number,
        default:0
    },
    orderCurrentCount:{
        type:Number,
        default:0
    },
    status:{
        type:String,
        enum:['active','paused','expired'],
        default:'paused'
    },
    lastActivatedAt:{
        type:Date,
        default:null
    },
    accumulatedUsedMs:{
        type:Number,
        default:0
    },
    remainingMsOverride:{
        type:Number,
        default:null
    },
    // Razorpay payment fields
    razorpayOrderId:{
        type:String,
        default:null
    },
    razorpayPaymentId:{
        type:String,
        default:null
    },
    razorpaySignature:{
        type:String,
        default:null
    },
    paymentStatus:{
        type:String,
        enum:['pending', 'completed', 'failed'],
        default:'pending'
    },
    totalCustomers:{
        type:Number,
        default:0
    },
    totalOrders:{
        type:Number,
        default:0
    },
    totalProducts:{
        type:Number,
        default:0
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }
},{timestamps:true})

module.exports = mongoose.model("PlanOrder",PlanOrderSchema);