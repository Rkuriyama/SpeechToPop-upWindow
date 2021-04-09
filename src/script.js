//// load word list
var GWL = {
    "test": "description",
    "ピーク": "壁から体を出す行為。",
    "ガジェット": "各オペレータに用意されている道具。"
}

//// 表示時間指定
const ActiveTime = 4000; // msec
document.documentElement.style.setProperty('--active-time', (ActiveTime/1000) + 's')


SpeechRecognition = webkitSpeechRecognition || SpeechRecognition;

var recogObj = {
    debug: false,
    state: {
        finalTranscript: 'hi',
        interimTranscript: '',
        list: ['test'],
        active: false,
        done: -1
    },
    control: new SpeechRecognition(),
    activate: function(idx) {
        console.log(this);
        this.state.done = idx;
        this.state.active = true;
        setTimeout(()=>{this.state.active=false;}, ActiveTime)
    }
}

recogObj.control.lang = 'ja-JP';
recogObj.control.interimResults = true;
recogObj.control.continuous = true;
recogObj.control.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
        let transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
            recogObj.state.finalTranscript += transcript;
            /*
            // キーワード検索して、合致したらキューに追加。pop up表示に投げる
            if(!recogObj.state.active){
                recogObj.state.list = searchWord(recogObj.state.finalTranscript, GWL);
                recogObj.state.finalTranscript = '';
                if(recogObj.state.list.length > 0)recogObj.activate();
            }
            */
        } else {
            console.log(transcript);
            recogObj.state.interimTranscript = transcript;

            // キーワード検索して、合致したらキューに追加。pop up表示に投げる
            if(!recogObj.state.active && recogObj.state.done < i){
                recogObj.state.list = searchWord(transcript, GWL);
                if(recogObj.state.list.length > 0){
                    recogObj.activate(i);
                }
            }
        }
    }
}



//////////////// 単語検索
function searchWord (script, wordList){
    let result = [];
    for(let key in wordList){
        let idx =  script.indexOf(key);
        if(idx >= 0){
            result.push(key);
        }
        console.log()
    }
    result.sort((a, b) => a.index - b.index);
    return result;
}

///////////////// ポップアップ
Vue.component('pop-up', {
    props:['title','description','show'],
    template: `
        <div id="background">
            <transition name="slide-up">
            <div v-if="show" id="pop_up_window">
                <div id="pop_up_title">{{title}}</div>
                <div id="pop_up_description">{{description}}</div>
            </div>
            </transition>
            <transition name="leak">
            <div v-if="show" id="active-bar">
            </div>
            </transition>
        </div>
    `
});

///////////////// リスト
Vue.component('wordlist',{
    props:['title', 'description','state', 'target'],
    template: `
            <button v-on:click="set">{{title}}</button>
    `,
    methods: {
        set: function(event){
            if(!this.state.active){
                this.state.list = [this.title];
                console.log(recogObj.state.list)
                this.target.activate(this.target.state.done); 
            }
        }
    }
   });


////////////////// 本体
var app = new Vue({
    el: '#app',
    data: {
        sharedObj: recogObj,
        state: recogObj.state,
        Words: GWL
    },
    methods: {
        start: function(event){
            this.sharedObj.control.start();
        },
        stop: function(event){
            this.sharedObj.control.stop();
            this.state.done = -1;
        }
    },
    computed: {
        title: function(){
            return this.state.list[0]
        },    
        description: function(){
          return GWL[ this.state.list[0] ];
        },
        show: function(){
            return (this.state.active);
        }
    }
});
